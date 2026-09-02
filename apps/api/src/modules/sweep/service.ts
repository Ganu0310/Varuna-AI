import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { hash as argonHash } from '@node-rs/argon2';
import { WATCH_REGIONS, watchRegionAoi, type WatchRegion } from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { audit } from '../audit/service.js';
import { enqueue } from '../../queue/producer.js';
import { searchCatalogue, planetaryComputer } from '../../providers/chain.js';
import type { CatalogueItem } from '../../providers/types.js';
import { ARGON_OPTS } from '../auth/service.js';
import { UserModel } from '../auth/model.js';
import { InvestigationModel } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SweepStateModel, SweepOverpassModel } from './model.js';

/**
 * Discover's background sweep — 06_BACKEND §6.4.10.
 *
 * A scheduled tick, not a live query: a Sentinel-1 scene is roughly 250×170 km and a live
 * provider read already costs real seconds even windowed to an AOI, and every provider is
 * under a shared quota (`../../providers/quota.ts`) used by real investigations too. So
 * Discover never searches on demand — it browses what this module has already found, on a
 * schedule, capped, for a small named list of watch regions rather than the whole ocean.
 *
 * Each region gets one persistent "sweep container" — a completely ordinary `Investigation`
 * document, flagged `kind: 'SWEEP_CONTAINER'` so it is invisible to every human-facing list
 * (see the field's own comment on `InvestigationSchema`), that the UNMODIFIED ingest pipeline
 * writes real scenes and detections into. Starting an investigation "from" a Discover result
 * is then just re-parenting that scene (and its sibling detections) onto a real investigation
 * — see `../discover/service.ts` — rather than a second ingest pipeline that could drift from
 * the first.
 */

/** At most this many NEW scenes are ingested per region per tick — see the plan's own
 * reasoning: quota tracking is shared and call-based, with no existing per-run budget, so
 * this is Discover's own throttle, independent of whatever headroom the shared quota has
 * left. Deliberately small: a demo-scale number, not a production monitoring budget. */
export const SWEEP_MAX_SCENES_PER_REGION_PER_TICK = 3;

/** How far back the very FIRST scheduled tick for a region looks. Later scheduled ticks
 * search only since `lastSweptAt`, so this normally matters once per region, ever. */
const FIRST_TICK_LOOKBACK_DAYS = 14;

/**
 * How far back a MANUAL sweep looks, ignoring `lastSweptAt` entirely.
 *
 * A scheduled tick is incremental on purpose — yesterday's gap is all it needs, and a wide
 * re-search every night would burn provider quota re-reading what it already has. A person
 * pressing "Discover now" wants the opposite: they are asking "what is out there?", not
 * "what changed in the last hour". Running the incremental window for them means the button
 * usually reports nothing and looks broken, which is exactly what it did the first time it
 * was pressed against a freshly-swept region.
 *
 * Re-seeing products is harmless: overpasses upsert on `(regionId, productId)` and ingest
 * dedupes on its own job key, so a wide manual sweep refreshes rather than duplicates.
 */
const MANUAL_SWEEP_LOOKBACK_DAYS = 30;

const SWEEP_SYSTEM_EMAIL = 'sweep@varuna.internal';

/**
 * The account sweep containers are `createdBy`. Created once, disabled from the moment it
 * exists — `disabledAt` is checked at both login and refresh
 * (`../auth/service.ts`), so this account can never authenticate over HTTP no matter what
 * happens to its password hash. It exists only to be a real, auditable actor id.
 */
export async function ensureSweepSystemUser(): Promise<string> {
  const existing = await UserModel.findOne({ email: SWEEP_SYSTEM_EMAIL }).lean();
  if (existing) return String(existing._id);

  const passwordHash = await argonHash(randomBytes(32).toString('hex'), ARGON_OPTS);
  const doc = await UserModel.create({
    email: SWEEP_SYSTEM_EMAIL,
    name: 'Discover sweep (system)',
    passwordHash,
    role: 'admin',
    disabledAt: new Date(),
  });
  return String(doc._id);
}

/**
 * The region's persistent container, created on first use. Its own `windowStart`/`windowEnd`
 * are bookkeeping only — nothing runs origin estimation or AIS correlation against a
 * container directly, only against a real investigation after adoption — so it is simply
 * given a window wide enough to satisfy the schema without claiming to bound one incident.
 */
async function ensureContainer(region: WatchRegion, systemUserId: string): Promise<string> {
  const state = await SweepStateModel.findOne({ regionId: region.id }).lean();
  if (state) return String(state.containerInvestigationId);

  const aoi = rewindPolygon(watchRegionAoi(region) as never);
  const aoiAreaKm2 = geodesicPolygonAreaKm2(aoi as never) as number;
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + 30 * 86_400_000);

  const inv = await InvestigationModel.create({
    name: `Discover watch — ${region.label}`,
    description:
      `Internal container for VARUNA's Discover sweep. Not a case — scenes and detections ` +
      `land here automatically before anyone has opened an investigation. See "Start ` +
      `investigating" on the Discover map to adopt one into a real case.`,
    incidentReference: `sweep:${region.id}`,
    aoi,
    aoiAreaKm2,
    windowStart,
    windowEnd,
    status: 'DRAFT',
    kind: 'SWEEP_CONTAINER',
    createdBy: new Types.ObjectId(systemUserId),
    members: [],
  });

  await SweepStateModel.create({ regionId: region.id, containerInvestigationId: inv._id });
  await audit({
    actorId: systemUserId,
    action: 'SWEEP_CONTAINER_CREATED',
    entityType: 'Investigation',
    entityId: String(inv._id),
    after: { regionId: region.id, label: region.label },
  });
  return String(inv._id);
}

export interface ScenesToIngestSelection {
  toEnqueue: CatalogueItem[];
  /** Every overpass the provider returned, readable or not. */
  overpassesSeen: number;
  /** Of those, how many this pipeline can actually ingest. */
  candidateCount: number;
  /**
   * Real acquisitions that exist and cannot be used — raw GRD needing SNAP correction, say.
   * Counted separately because "nothing flew over" and "nothing readable flew over" are
   * different facts, and only one of them means the ocean was quiet.
   */
  skippedNotIngestible: number;
  skippedAlreadyIngested: number;
  skippedOverCap: number;
}

/**
 * Which of this tick's catalogue results actually get ingested — the whole point of the
 * per-run cap, pulled out as a pure function so it can be tested without a live provider
 * call or a database (`sweep.test.ts`).
 *
 * Filtered on `item.ingestible`, NOT on the collection name. `decideIngestible`
 * (`../../providers/chain.ts`) is the single place that rule lives, precisely so the
 * catalogue, the scene picker, the backfill CLI and now the sweep cannot each re-derive it
 * slightly differently — which is exactly what an earlier version of this function did, and
 * it silently found nothing: CDSE serves the same overpasses as raw `SENTINEL-1` needing
 * SNAP correction, so a `collection === 'sentinel-1-rtc'` test matched none of them and the
 * sweep reported a quiet ocean instead of "these exist, none are readable."
 *
 * Then: not already ingested for this region's container, newest first, capped at
 * `maxPerTick`. Newest first matters — a region that has fallen behind should catch up with
 * what is happening NOW rather than working through a backlog and never reaching the present.
 */
export function selectScenesToIngest(
  items: CatalogueItem[],
  alreadyIngestedProductIds: Set<string>,
  maxPerTick: number,
): ScenesToIngestSelection {
  const candidates = items
    .filter((i) => i.ingestible)
    .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt));

  const toEnqueue: CatalogueItem[] = [];
  let skippedAlreadyIngested = 0;
  let skippedOverCap = 0;

  for (const item of candidates) {
    if (alreadyIngestedProductIds.has(item.productId)) {
      skippedAlreadyIngested++;
      continue;
    }
    if (toEnqueue.length >= maxPerTick) {
      skippedOverCap++;
      continue;
    }
    toEnqueue.push(item);
  }

  return {
    toEnqueue,
    overpassesSeen: items.length,
    candidateCount: candidates.length,
    skippedNotIngestible: items.length - candidates.length,
    skippedAlreadyIngested,
    skippedOverCap,
  };
}

/**
 * How long a recorded overpass is kept. Long enough to cover the widest browse window
 * Discover allows (90 days) with room to spare, short enough that the collection stays small
 * without a TTL index that would delete rows the browse window still reaches.
 */
export const OVERPASS_RETENTION_DAYS = 180;

/**
 * Keep every acquisition the sweep saw, readable or not.
 *
 * The ingestible ones go on to be ingested; the rest are the answer to "did anything even fly
 * over here?", which is the question an empty Discover map otherwise cannot answer. Upserted
 * on `(regionId, productId)` so a repeat tick refreshes what it already knows instead of
 * accumulating duplicates.
 */
export async function recordOverpasses(regionId: string, items: CatalogueItem[]): Promise<void> {
  const seenAt = new Date();
  if (items.length > 0) {
    await SweepOverpassModel.bulkWrite(
      items.map((i) => ({
        updateOne: {
          filter: { regionId, productId: i.productId },
          update: {
            $set: {
              provider: i.provider,
              stacCollection: i.collection,
              acquiredAt: new Date(i.acquiredAt),
              platform: i.platform ?? null,
              footprint: i.footprint ?? null,
              ingestible: Boolean(i.ingestible),
              ingestibleReason: i.ingestibleReason ?? null,
              seenAt,
            },
          },
          upsert: true,
        },
      })),
    );
  }

  // Pruned per region on every tick rather than by a TTL index: the cutoff is on the
  // ACQUISITION date, which is what the browse window filters on, and a TTL index can only
  // expire on a fixed field age.
  await SweepOverpassModel.deleteMany({
    regionId,
    acquiredAt: { $lt: new Date(Date.now() - OVERPASS_RETENTION_DAYS * 86_400_000) },
  });
}

export interface SweepRegionResult {
  regionId: string;
  label: string;
  containerInvestigationId: string;
  /** Every overpass the provider returned for this region and window. */
  overpassesSeen: number;
  /** Of those, how many were in a form this pipeline can ingest. `found` is this number. */
  found: number;
  /** Real acquisitions that exist but cannot be read — see `skippedNotIngestible`. */
  notIngestible: number;
  enqueued: number;
  skippedAlreadyIngested: number;
  skippedOverCap: number;
  error: string | null;
}

/** One region, one tick. Exported separately from `runSweepTick` so a test — or a future
 * manual "sweep this region now" admin action — can run a single region without the rest. */
export async function sweepRegionTick(
  region: WatchRegion,
  systemUserId: string,
  opts: { manual?: boolean } = {},
): Promise<SweepRegionResult> {
  const base: Pick<SweepRegionResult, 'regionId' | 'label'> = {
    regionId: region.id,
    label: region.label,
  };

  let containerInvestigationId: string;
  try {
    containerInvestigationId = await ensureContainer(region, systemUserId);
  } catch (e) {
    return {
      ...base,
      containerInvestigationId: '',
      overpassesSeen: 0,
      found: 0,
      notIngestible: 0,
      enqueued: 0,
      skippedAlreadyIngested: 0,
      skippedOverCap: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const state = await SweepStateModel.findOne({ regionId: region.id });
  const lookbackDays = opts.manual ? MANUAL_SWEEP_LOOKBACK_DAYS : FIRST_TICK_LOOKBACK_DAYS;
  const from =
    !opts.manual && state?.lastSweptAt
      ? state.lastSweptAt.toISOString()
      : new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const to = new Date().toISOString();

  try {
    /**
     * Searched against Planetary Computer ALONE, not the full catalogue chain.
     *
     * The chain de-duplicates across providers and CDSE is first, so the same overpass comes
     * back as CDSE's raw `SENTINEL-1` product and the Planetary Computer RTC version — the
     * only one `/ingest` can actually read — is dropped as a duplicate. A blended search is
     * right for a human browsing coverage in the Satellite Browser; it is wrong here, where
     * every result that is not ingestible is a result this job can do nothing with.
     */
    const { items } = await searchCatalogue({ aoi: watchRegionAoi(region) as never, from, to }, [
      planetaryComputer,
    ]);

    const already = new Set(
      (
        await SatelliteSceneModel.find(
          { investigationId: new Types.ObjectId(containerInvestigationId) },
          { productId: 1 },
        ).lean()
      ).map((s) => s.productId as string),
    );

    await recordOverpasses(region.id, items);

    const selection = selectScenesToIngest(items, already, SWEEP_MAX_SCENES_PER_REGION_PER_TICK);

    for (const item of selection.toEnqueue) {
      const bbox = item.bbox ?? region.bbox;
      await enqueue({
        queue: 'ingest',
        kind: 'INGEST',
        jobKey: `ingest:${containerInvestigationId}:${item.productId}`,
        payload: {
          investigationId: containerInvestigationId,
          productId: item.productId,
          aoi: bbox,
          collection: item.collection,
        },
        investigationId: containerInvestigationId,
        userId: systemUserId,
      });
    }
    const enqueued = selection.toEnqueue.length;
    const skippedAlreadyIngested = selection.skippedAlreadyIngested;
    const skippedOverCap = selection.skippedOverCap;
    const candidates = selection.candidateCount;

    await SweepStateModel.updateOne(
      { regionId: region.id },
      {
        $set: {
          lastSweptAt: new Date(to),
          // Persisted so Discover can explain an empty map instead of implying a quiet sea.
          lastResult: {
            overpassesSeen: selection.overpassesSeen,
            ingestible: candidates,
            enqueued,
            error: null,
          },
        },
      },
    );

    if (enqueued > 0) {
      await audit({
        actorId: systemUserId,
        action: 'SWEEP_TICK_ENQUEUED',
        entityType: 'Investigation',
        entityId: containerInvestigationId,
        after: { regionId: region.id, enqueued, found: candidates },
      });
    }

    return {
      ...base,
      containerInvestigationId,
      overpassesSeen: selection.overpassesSeen,
      found: candidates,
      notIngestible: selection.skippedNotIngestible,
      enqueued,
      skippedAlreadyIngested,
      skippedOverCap,
      error: null,
    };
  } catch (e) {
    // A failed tick for one region must never fail the others — see `runSweepTick`, which
    // calls this per region rather than in one query that could take the whole sweep down.
    logger.error({ err: e, regionId: region.id }, 'sweep tick failed for region');
    return {
      ...base,
      containerInvestigationId,
      overpassesSeen: 0,
      found: 0,
      notIngestible: 0,
      enqueued: 0,
      skippedAlreadyIngested: 0,
      skippedOverCap: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * One tick. Every watch region by default; a single region when `regionId` is given, which is
 * what the "Discover now" button uses so pressing it while looking at one region costs one
 * region's worth of provider calls rather than four.
 */
export async function runSweepTick(
  regionId?: string,
  opts: { manual?: boolean } = {},
): Promise<SweepRegionResult[]> {
  const systemUserId = await ensureSweepSystemUser();
  const regions = regionId ? WATCH_REGIONS.filter((r) => r.id === regionId) : WATCH_REGIONS;
  const results: SweepRegionResult[] = [];
  // Sequential, not `Promise.all`: regions share the same provider quota, and running them
  // concurrently would only make the shared rate limit the effective throttle instead of the
  // deliberate per-region cap above.
  for (const region of regions) {
    results.push(await sweepRegionTick(region, systemUserId, opts));
  }
  return results;
}
