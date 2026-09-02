/**
 * `pnpm --filter @varuna/api scenes:backfill -- [--owner <email>] [--dry-run]`
 *
 * Queue one real scene ingest for every investigation that has none.
 *
 * An investigation with no scene is a case that cannot show anything: no raster, no
 * detections, no back-track, nothing for the dashboard tiles to count. Creating six
 * investigations and leaving them empty produces a system that looks built and demonstrates
 * nothing, so this walks them and starts the chain on each.
 *
 * It searches the catalogue per investigation rather than taking a product id, for the same
 * reason the verified scenario does: a pinned id rots the moment a provider reprocesses its
 * archive, and searching proves the catalogue chain works as a side effect.
 *
 * `platforms: ['SENTINEL-1']` is load-bearing. The Planetary Computer client defaults to
 * `sentinel-1-grd` ALONE when platforms are unset — so the one collection ingest can read,
 * `sentinel-1-rtc`, is never queried, the chain falls through to a CDSE product, and every
 * job dies downstream with a 404 that reads like an outage.
 */
import mongoose from 'mongoose';
import { env } from '../../env.js';
import { UserModel } from '../auth/model.js';
import { InvestigationModel } from '../investigations/model.js';
import { enqueue } from '../../queue/producer.js';
import { searchCatalogue } from '../../providers/chain.js';
import { SatelliteSceneModel } from './model.js';

const INGESTIBLE = 'sentinel-1-rtc';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  const ownerEmail = arg('owner')?.trim().toLowerCase();
  const owner = ownerEmail
    ? await UserModel.findOne({ email: ownerEmail }).lean()
    : await UserModel.findOne({ role: 'admin' }).lean();
  if (!owner) {
    console.error('\nNo user to attribute the jobs to. Pass --owner <email>.\n');
    await mongoose.disconnect();
    process.exit(1);
  }

  const investigations = await InvestigationModel.find({ deletedAt: null }).sort({ _id: 1 }).lean();

  console.log(`\n${investigations.length} investigation(s); jobs attributed to ${owner.email}\n`);

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const inv of investigations) {
    const name = String(inv.name ?? inv._id);

    const already = await SatelliteSceneModel.countDocuments({ investigationId: inv._id });
    if (already > 0) {
      console.log(`  skip   ${name} — ${already} scene(s) already`);
      skipped += 1;
      continue;
    }

    const ring = (inv.aoi as unknown as { coordinates: number[][][] }).coordinates[0]!;
    const lons = ring.map((c) => c[0]!);
    const lats = ring.map((c) => c[1]!);
    const bbox: [number, number, number, number] = [
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats),
    ];

    try {
      const found = await searchCatalogue({
        aoi: inv.aoi as never,
        from: new Date(inv.windowStart as Date).toISOString(),
        to: new Date(inv.windowEnd as Date).toISOString(),
        platforms: ['SENTINEL-1'],
        limit: 25,
      });

      const rtc = found.items
        .filter((i) => i.collection === INGESTIBLE && i.provider === 'PLANETARY_COMPUTER')
        // Most AOI coverage first: a scene clipping the corner of the box gives the detector
        // mostly nodata to look at.
        .sort((a, b) => (b.aoiOverlapPct ?? 0) - (a.aoiOverlapPct ?? 0));

      const match = rtc[0];
      if (!match) {
        console.log(
          `  FAIL   ${name} — no ${INGESTIBLE} product from Planetary Computer in this window` +
            (found.items.length
              ? ` (${found.items.length} other acquisition(s) offered)`
              : ' (no provider returned anything)'),
        );
        failed += 1;
        continue;
      }

      if (dryRun) {
        console.log(
          `  would  ${name} — ${match.productId} (${match.aoiOverlapPct ?? '?'}% of AOI)`,
        );
        continue;
      }

      const { jobId, deduplicated } = await enqueue({
        queue: 'ingest',
        kind: 'INGEST',
        jobKey: `ingest:${String(inv._id)}:${match.productId}`,
        payload: {
          investigationId: String(inv._id),
          productId: match.productId,
          aoi: bbox,
          collection: INGESTIBLE,
        },
        investigationId: String(inv._id),
        userId: String(owner._id),
      });

      console.log(
        `  queued ${name} — ${match.productId}` + (deduplicated ? ' (already queued)' : ''),
      );
      if (!jobId) console.log('         (no job id returned)');
      queued += 1;
    } catch (err) {
      // One investigation failing must not abandon the rest; the reason is printed per case.
      console.log(`  FAIL   ${name} — ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  console.log(`\n  ${queued} queued, ${skipped} already had a scene, ${failed} failed.\n`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
