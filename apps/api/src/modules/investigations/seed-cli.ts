/**
 * `pnpm --filter @varuna/api investigations:seed -- --owner <email> [--dry-run]`
 *
 * Creates the Marianas incident set — six real Sentinel-1C acquisitions over water this
 * project actually holds AIS for.
 *
 * Every parameter here was MEASURED, not chosen for plausibility:
 *
 *  - the six acquisition times come from the Planetary Computer STAC catalogue
 *    (`sentinel-1-rtc` over 144.42,13.72,147.07,15.81), which returns 37 scenes, all in 2025,
 *    on a 12-day repeat at ~20:07 UTC descending. There is no RTC coverage here for 2023 or
 *    2024, so no earlier date is offerable;
 *  - the AOIs were picked by AIS density counted over the real 2025 Guam archive. The
 *    Saipan/Tinian box holds 39 positions for the entire year and is deliberately EXCLUDED:
 *    it has imagery and no traffic, so it would yield detections and no candidates;
 *  - Copernicus Marine currents were confirmed live for 2025-04-30, 06-29, 09-21 and 12-26,
 *    so the whole span back-tracks on a real field rather than degrading to proximity.
 *
 * It runs through `createInvestigation`, so winding normalisation, the AOI area limit and the
 * audit entry all happen exactly as they do for an analyst clicking Create. It takes an owner
 * EMAIL rather than a password: seeding should not require anyone's credential, and a script
 * that asks for one teaches a habit worth not having.
 */
import mongoose from 'mongoose';
import { env } from '../../env.js';
import { UserModel } from '../auth/model.js';
import { InvestigationModel } from './model.js';
import type { CreateInvestigationBody } from './schema.js';
import { createInvestigation } from './service.js';

interface SeedCase {
  name: string;
  incidentReference: string;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  acquired: string;
  aisNote: string;
}

const CASES: SeedCase[] = [
  {
    name: 'Guam — Apra Harbour, 30 Apr 2025',
    incidentReference: 'VARUNA-GUAM-2025-04-30',
    bbox: [144.55, 13.3, 144.95, 13.6],
    acquired: '2025-04-30T20:07:40Z',
    aisNote: '2,672,855 positions / 298 vessels in this box across 2025',
  },
  {
    name: 'Guam approaches, 17 Jun 2025',
    incidentReference: 'VARUNA-GUAM-2025-06-17',
    bbox: [144.4, 13.15, 145.1, 13.8],
    acquired: '2025-06-17T20:07:43Z',
    aisNote: '2,866,664 positions / 321 vessels in this box across 2025',
  },
  {
    name: 'Guam north approaches, 4 Aug 2025',
    incidentReference: 'VARUNA-GUAM-2025-08-04',
    bbox: [144.4, 13.2, 145.4, 14.2],
    acquired: '2025-08-04T20:07:46Z',
    aisNote: '2,919,822 positions / 355 vessels in this box across 2025',
  },
  {
    name: 'Guam — Apra Harbour, 21 Sep 2025',
    incidentReference: 'VARUNA-GUAM-2025-09-21',
    bbox: [144.55, 13.3, 144.95, 13.6],
    acquired: '2025-09-21T20:07:48Z',
    aisNote: 'the proven incident — back-tracks 9.90 km on a real CMEMS field',
  },
  {
    name: 'Guam wide, 15 Oct 2025',
    incidentReference: 'VARUNA-GUAM-2025-10-15',
    bbox: [144.4, 13.15, 145.1, 13.8],
    acquired: '2025-10-15T20:07:48Z',
    aisNote: '2,866,664 positions / 321 vessels in this box across 2025',
  },
  {
    name: 'Marianas transit corridor, 26 Dec 2025',
    incidentReference: 'VARUNA-MARIANAS-2025-12-26',
    // The Sentinel-1 footprint here is 144.42,13.72,147.07,15.81 — but that is 65,986 km²
    // and the AOI ceiling is 50,000. Trimmed to the part of the swath the traffic actually
    // uses: 36,432 km², and it still holds 46,469 of the corridor's 72,256 positions.
    bbox: [144.6, 13.8, 146.3, 15.6],
    acquired: '2025-12-26T20:07:45Z',
    aisNote: '46,469 positions / 156 vessels — open-ocean transits, not harbour traffic',
  },
];

/** west, south, east, north -> a counter-clockwise closed ring (RFC 7946 right-hand rule). */
function bboxPolygon([w, s, e, n]: [
  number,
  number,
  number,
  number,
]): CreateInvestigationBody['aoi'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ] as [number, number][],
    ],
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ownerEmail = arg('owner')?.trim().toLowerCase();
  const dryRun = process.argv.includes('--dry-run');

  if (!ownerEmail) {
    console.error(
      '\nUsage: investigations:seed -- --owner <email> [--dry-run]\n' +
        '  The owner must already exist; register through the web app first.\n',
    );
    process.exit(2);
  }

  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  const owner = await UserModel.findOne({ email: ownerEmail }).lean();
  if (!owner) {
    console.error(`\nNo user with email "${ownerEmail}". Register through the web app first.\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const actor = { id: String(owner._id), role: owner.role as never };
  let created = 0;
  let skipped = 0;
  let failed = 0;

  console.log('');
  for (const c of CASES) {
    // Keyed on the incident reference so re-running the seed does not produce six more
    // copies of the same six cases.
    const existing = await InvestigationModel.findOne({
      incidentReference: c.incidentReference,
    }).lean();
    if (existing) {
      console.log(`  skip  ${c.incidentReference}  already exists (${String(existing._id)})`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  would create  ${c.incidentReference}  ${c.name}`);
      continue;
    }

    const acq = new Date(c.acquired);
    // The catalogue window brackets the acquisition by half a day either side. Tight on
    // purpose: the repeat cycle here is 12 days, so a wider window returns the neighbouring
    // pass too and an analyst has to separate them by timestamp alone.
    const windowStart = new Date(acq.getTime() - 12 * 3_600_000).toISOString();
    const windowEnd = new Date(acq.getTime() + 12 * 3_600_000).toISOString();

    try {
      const doc = await createInvestigation(
        {
          name: c.name,
          incidentReference: c.incidentReference,
          description:
            `Sentinel-1C RTC acquisition ${c.acquired} (descending, ~20:07 UTC). ` +
            `AOI ${c.bbox.join(', ')}. AIS: ${c.aisNote}. ` +
            'Ocean currents from Copernicus Marine. Wind reads UNKNOWN until the ERA5 licence ' +
            'is accepted on the Climate Data Store, and the drift is labelled degraded for it.',
          aoi: bboxPolygon(c.bbox),
          windowStart,
          windowEnd,
          reportedIncidentAt: c.acquired,
        },
        actor,
        'seed-cli',
      );

      console.log(`  ok    ${String(doc._id)}  ${c.name}`);
      created += 1;
    } catch (err) {
      // One rejected case must not abandon the rest. The AOI area limit is the usual cause
      // and it is a per-case fact, so the others are still perfectly creatable — aborting
      // the run would leave the set half-seeded with no report of what was missed.
      const detail =
        err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : String(err);
      console.log(`  FAIL  ${c.incidentReference}  ${detail}`);
      failed += 1;
    }
  }

  console.log(
    `\n  ${created} created, ${skipped} already present, ${failed} failed, owner ${ownerEmail}.\n` +
      '  Next: import the AIS slice for each window, then run the chain from the workspace.\n',
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
