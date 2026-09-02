import { Types } from 'mongoose';
import type { Role } from '@varuna/shared';
import { logger } from '../../lib/logger.js';
import { searchCatalogue } from '../../providers/chain.js';
import { enqueue } from '../../queue/producer.js';
import { audit } from '../audit/service.js';
import { InvestigationModel } from '../investigations/model.js';
import { createInvestigation } from '../investigations/service.js';
import { SatelliteSceneModel } from '../scenes/model.js';

/**
 * The verified scenario — one click from an empty screen to a real ingest running.
 *
 * A demo that needs eight manual steps is a demo that fails in front of an audience, so this
 * performs the three that are pure setup — find or create the investigation, locate the real
 * product in a live catalogue, queue the ingest — and stops there.
 *
 * IT DELIBERATELY STOPS THERE. Detection, back-tracking and ranking are NOT run: they are the
 * part an evaluator is here to watch, and pre-computing them would turn a live demonstration
 * into a playback of a result prepared earlier. The staging rule this follows is the same one
 * `stage:demo` follows — cache the real INPUTS, never the conclusions.
 *
 * Everything is idempotent. Re-clicking finds the existing investigation and de-duplicates the
 * ingest job rather than producing a second case and a second multi-second provider read.
 *
 * The scene is resolved by SEARCHING, not by a hard-coded product id. A pinned id rots the
 * first time a provider re-processes its archive, and it would fail at the worst moment with
 * the least informative error. Searching also proves the catalogue chain works, which is
 * itself part of what the demo is claiming.
 */

/**
 * Guam — Apra Harbour, 2025-09-21.
 *
 * Every value measured, not chosen: the acquisition is one of 18 real Sentinel-1C RTC scenes
 * the Planetary Computer holds over this box; the AOI carries 2,672,855 real AIS positions
 * across 2025; and Copernicus Marine currents were confirmed live for this date, so the
 * back-track runs on a real field rather than degrading to footprint proximity.
 */
export const VERIFIED = {
  incidentReference: 'VARUNA-GUAM-2025-09-21',
  name: 'Guam — Apra Harbour, 21 Sep 2025',
  bbox: [144.55, 13.3, 144.95, 13.6] as [number, number, number, number],
  acquired: '2025-09-21T20:07:48Z',
  collection: 'sentinel-1-rtc',
} as const;

export interface VerifiedDemoStep {
  step: string;
  outcome: 'OK' | 'REUSED' | 'FAILED';
  detail: string;
}

export interface VerifiedDemoResult {
  investigationId: string | null;
  jobId: string | null;
  productId: string | null;
  steps: VerifiedDemoStep[];
  /** What the operator should do next, in the workspace. Never done for them. */
  nextSteps: string[];
}

export async function runVerifiedDemo(
  actor: { id: string; role: Role },
  requestId?: string,
): Promise<VerifiedDemoResult> {
  const steps: VerifiedDemoStep[] = [];
  const result: VerifiedDemoResult = {
    investigationId: null,
    jobId: null,
    productId: null,
    steps,
    nextSteps: [
      'Review the detections and confirm or reject each one.',
      'Run the back-track to get the probable origin zone and release-time window.',
      'Correlate against AIS, then rank the candidate vessels.',
      'Generate the dossier.',
    ],
  };

  // ── 1. the investigation ────────────────────────────────────────────────
  let inv = await InvestigationModel.findOne({
    incidentReference: VERIFIED.incidentReference,
    deletedAt: null,
  }).lean();

  if (inv) {
    steps.push({
      step: 'INVESTIGATION',
      outcome: 'REUSED',
      detail: `Using the existing "${inv.name}".`,
    });
  } else {
    const acq = new Date(VERIFIED.acquired);
    const [w, s, e, n] = VERIFIED.bbox;
    const created = await createInvestigation(
      {
        name: VERIFIED.name,
        incidentReference: VERIFIED.incidentReference,
        description:
          `Sentinel-1C RTC acquisition ${VERIFIED.acquired} (descending, ~20:07 UTC). ` +
          'Real AIS from the NOAA Marine Cadastre Guam archive; ocean currents from ' +
          'Copernicus Marine. Created by the verified-scenario button.',
        aoi: {
          type: 'Polygon',
          // Counter-clockwise: MongoDB reads a clockwise exterior as the polygon's complement.
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ] as [number, number][],
          ],
        },
        windowStart: new Date(acq.getTime() - 12 * 3_600_000).toISOString(),
        windowEnd: new Date(acq.getTime() + 12 * 3_600_000).toISOString(),
        reportedIncidentAt: VERIFIED.acquired,
      },
      actor,
      requestId,
    );
    inv = created as unknown as typeof inv;
    steps.push({ step: 'INVESTIGATION', outcome: 'OK', detail: `Created "${VERIFIED.name}".` });
  }

  const investigationId = String(inv!._id);
  result.investigationId = investigationId;

  // ── 2. the scene, if it is not already in ───────────────────────────────
  const existingScene = await SatelliteSceneModel.findOne({
    investigationId: new Types.ObjectId(investigationId),
  }).lean();

  if (existingScene) {
    steps.push({
      step: 'SCENE',
      outcome: 'REUSED',
      detail: `Scene ${String(existingScene.productId ?? existingScene._id)} is already ingested.`,
    });
    result.productId = existingScene.productId ? String(existingScene.productId) : null;
    return result;
  }

  // ── 3. find the real product in a live catalogue ────────────────────────
  const [w, s, e, n] = VERIFIED.bbox;
  const acq = new Date(VERIFIED.acquired);
  let productId: string | null = null;

  try {
    const found = await searchCatalogue({
      aoi: {
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
      // A six-hour bracket. The repeat cycle here is 12 days, so this cannot pick up the
      // neighbouring pass, and a tight window keeps the provider read small.
      from: new Date(acq.getTime() - 6 * 3_600_000).toISOString(),
      to: new Date(acq.getTime() + 6 * 3_600_000).toISOString(),
      // Naming the platform is what makes Planetary Computer search `sentinel-1-rtc` at all.
      // With `platforms` unset its client defaults to `sentinel-1-grd` ALONE — so the one
      // collection the ML service can ingest was never queried, PC returned nothing, and the
      // chain fell through to a CDSE product that `/ingest` cannot resolve.
      platforms: ['SENTINEL-1'],
      limit: 10,
    });

    // WHICH provider answered matters, and not for redundancy reasons.
    //
    // `searchCatalogue` queries the chain in parallel and CDSE sorts first, so it was
    // returning a CDSE product id ending `.SAFE`. The ML service's `/ingest` resolves ids
    // against the Planetary Computer `sentinel-1-rtc` collection, where that id does not
    // exist — so every queued ingest died with `ML_SERVICE unavailable: HTTP_404`, which
    // reads like an outage and was actually a provider mismatch.
    //
    // The RTC product is also the one we WANT: it is radiometrically terrain-corrected
    // already, which is why `SATELLITE_DOWNLOAD_CHAIN` puts Planetary Computer first for
    // downloads even though CDSE leads for search. Selecting on ingestibility rather than on
    // whoever replied first.
    const ingestible = found.items.filter(
      (i) => i.collection === VERIFIED.collection && i.provider === 'PLANETARY_COMPUTER',
    );
    const match = ingestible[0] ?? null;

    if (!match) {
      const offered = found.items.map((i) => `${i.provider}:${i.collection}`).join(', ');
      steps.push({
        step: 'CATALOGUE',
        outcome: 'FAILED',
        detail:
          `No ${VERIFIED.collection} product from Planetary Computer for this window. ` +
          'Ingest resolves product ids against that collection, so a product from another ' +
          'provider cannot be read even though the scene exists. ' +
          (offered ? `Offered instead: ${offered}.` : 'No provider returned anything.'),
      });
      return result;
    }

    productId = match.productId;
    result.productId = productId;
    steps.push({
      step: 'CATALOGUE',
      outcome: 'OK',
      detail: `Found ${match.productId} from ${match.provider}, acquired ${match.acquiredAt}.`,
    });
  } catch (err) {
    logger.warn({ err }, 'verified demo: catalogue search failed');
    steps.push({
      step: 'CATALOGUE',
      outcome: 'FAILED',
      detail:
        'Every catalogue provider failed. The investigation exists and the AIS is loaded; ' +
        'the scene can be ingested from the Satellite Browser once a provider answers.',
    });
    return result;
  }

  // ── 4. queue the real ingest ────────────────────────────────────────────
  const { jobId, deduplicated } = await enqueue({
    queue: 'ingest',
    kind: 'INGEST',
    jobKey: `ingest:${investigationId}:${productId}`,
    payload: {
      investigationId,
      productId,
      aoi: [w, s, e, n],
      collection: VERIFIED.collection,
    },
    investigationId,
    userId: actor.id,
  });

  result.jobId = jobId;
  steps.push({
    step: 'INGEST',
    outcome: deduplicated ? 'REUSED' : 'OK',
    detail: deduplicated
      ? 'An identical ingest was already queued; reusing it rather than reading the provider twice.'
      : 'Queued. The worker windows the scene to the AOI, writes a COG, and runs detection.',
  });

  await audit({
    actorId: actor.id,
    action: 'VERIFIED_DEMO_STARTED',
    entityType: 'Investigation',
    entityId: investigationId,
    after: { productId, jobId, deduplicated },
    requestId,
  });

  return result;
}
