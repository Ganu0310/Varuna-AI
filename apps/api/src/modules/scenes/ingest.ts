import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { ProviderUnavailable } from '../../errors.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import { recordProvenance } from '../provenance/service.js';
import { SatelliteSceneModel } from './model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { assessTriage, selectForPrecompute, type TriageAssessment } from '../detections/triage.js';
import { evaluateAutoReview } from '../detections/autoReview.js';
import { enqueue } from '../../queue/producer.js';
import { audit } from '../audit/service.js';

/**
 * Ingest orchestration — Phase 4 (IMPLEMENTATION_PLAN §14.6).
 *
 * The Node side owns persistence and provenance; the Python service owns raster work
 * (03_ARCHITECTURE §3.3). This module is the seam: it calls the ML service, then writes
 * `SatelliteScene` and `SpillDetection` documents that each carry a provenance record
 * pointing at the real provider product.
 *
 * Nothing here invents a value. If the ML service cannot geocode a scene, or a detection
 * lacks geometry, the record is not written — an absent scene is a truthful state, an
 * ungeoreferenced one is not (13_REAL_DATA_POLICY §13.4).
 */

interface MlIngestResponse {
  product_id: string;
  collection: string;
  acquired_at: string;
  platform: string;
  polarisations: string[];
  orbit_direction: string | null;
  mode: string | null;
  crs: string;
  pixel_size_m: number;
  width: number;
  height: number;
  bucket: string;
  cog_keys: Record<string, string>;
  size_bytes: number;
  aoi_bounds: [number, number, number, number];
  valid_pixel_fraction: number;
  preprocessing: string;
  seconds: number;
  provenance: {
    sourceType: string;
    provider: string;
    datasetId: string;
    externalId: string;
    retrievedAt: string;
    licence: string;
    accessUrl?: string;
  };
}

interface MlDetection {
  rank: number;
  geometry: Polygon;
  areaKm2: number;
  perimeterKm: number;
  morphology: {
    majorAxisKm: number;
    minorAxisKm: number;
    elongationRatio: number;
    orientationDeg: number;
    convexity: number;
  };
  backscatter: { meanDb: number; backgroundDb: number; contrastDb: number };
  lookAlikeRisk: number;
  confidence: number;
}

interface MlDetectResponse {
  detections: MlDetection[];
  detector: { name: string; version: string; limitation: string };
  scene: { bucket: string; key: string; pixelSizeM: number };
}

async function callMl<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.ML_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': env.ML_SERVICE_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ProviderUnavailable(
      'ML_SERVICE',
      `HTTP_${res.status}`,
      undefined,
      detail.slice(0, 400),
      [{ provider: 'ML_SERVICE', outcome: `HTTP_${res.status}` }],
      'Scene processing is unavailable. No scene or detection record was written, so no ' +
        'partial or unverified result enters the investigation.',
    );
  }
  return (await res.json()) as T;
}

/** Bounds -> a right-hand-wound footprint polygon. */
function boundsToPolygon([w, s, e, n]: [number, number, number, number]): Polygon {
  return rewindPolygon({
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
  });
}

/**
 * Where the pixels come from.
 *
 * The two sources differ only in how the raster is obtained; everything after that — the
 * scene record, the provenance chain, detection, the geodesic area recomputation — is
 * identical, and must stay identical. An upload that took a shortcut past any of it would be
 * a second, weaker pipeline whose outputs are indistinguishable from the first's.
 *
 * The ML service returns the same shape from `/ingest` and `/adopt` for exactly this reason.
 */
export type SceneSource =
  | { kind: 'CATALOGUE'; collection?: string }
  | {
      kind: 'UPLOAD';
      bucket: string;
      key: string;
      /**
       * The observation instant. Either the uploader stated it, or the FILE stated it
       * unambiguously — a mission product identifier, or a metadata key that means
       * acquisition rather than production. Never `TIFFTAG_DATETIME`, which is when the file
       * was WRITTEN: for a re-exported product, the day someone opened it in a GIS. Every AIS
       * query is a window around this instant, so a value inferred from a weak signal would
       * search the wrong day and rank vessels that were nowhere near the spill.
       */
      acquiredAt: string;
      /**
       * Which of those two it was, kept beside the value. A dossier that rests on this
       * instant should be able to say whether a person asserted it or the file did.
       */
      acquiredAtSource?: string | null;
      /** Read off a mission product identifier, when the file carries one. */
      platform?: string | null;
      uploadedBy?: string;
      originalName?: string;
      checksum?: string;
    };

export interface IngestSceneInput {
  investigationId: string;
  productId: string;
  aoi: [number, number, number, number];
  collection?: string;
  /** Defaults to CATALOGUE, so existing callers are unchanged. */
  source?: SceneSource;
  onProgress?: (pct: number, stage: string, message?: string) => void | Promise<void>;
}

export interface IngestSceneOutput {
  sceneId: string;
  productId: string;
  detectionIds: string[];
  detectionCount: number;
  /**
   * Detections for which back-tracking was queued without anyone asking. Reported so the job
   * result states what the pipeline did on its own initiative rather than leaving it implicit.
   */
  precomputedDetectionIds: string[];
  seconds: number;
}

export async function ingestAndDetect(input: IngestSceneInput): Promise<IngestSceneOutput> {
  const started = Date.now();
  const progress = input.onProgress ?? (() => {});

  const source: SceneSource = input.source ?? { kind: 'CATALOGUE', collection: input.collection };

  // ── 1 · obtain the raster ─────────────────────────────────────────
  let ing: MlIngestResponse;
  if (source.kind === 'UPLOAD') {
    await progress(15, 'ADOPT', 'Reading the uploaded scene');
    // `/adopt` resolves the CRS properly, which the API's header check could not. A GeoTIFF
    // can name a coordinate system that pyproj cannot construct, and this is the last point
    // before detections would be produced in pixel space and written out as positions.
    ing = await callMl<MlIngestResponse>('/adopt', {
      bucket: source.bucket,
      key: source.key,
      productId: input.productId,
      acquiredAt: source.acquiredAt,
      // Only ever set when the file's own name follows a mission product convention. The ML
      // service falls back to OPERATOR_SUPPLIED when it is absent, which is the truthful
      // answer for a file that does not say what took it.
      platform: source.platform ?? undefined,
      uploadedBy: source.uploadedBy,
      originalName: source.originalName,
      checksum: source.checksum,
    });
  } else {
    await progress(5, 'CATALOGUE', `Resolving ${input.productId}`);
    await progress(15, 'DOWNLOAD', 'Reading the AOI window from the provider');
    ing = await callMl<MlIngestResponse>('/ingest', {
      productId: input.productId,
      aoi: input.aoi,
      collection: source.collection ?? 'sentinel-1-rtc',
    });
  }

  await progress(55, 'PERSIST', 'Recording the scene');

  const footprint = boundsToPolygon(ing.aoi_bounds);
  const sceneProvenanceId = await recordProvenance({
    sourceType: 'SATELLITE_SCENE',
    provider: ing.provenance.provider,
    datasetId: ing.provenance.datasetId,
    externalId: ing.provenance.externalId,
    retrievedAt: ing.provenance.retrievedAt,
    licence: ing.provenance.licence,
    accessUrl: ing.provenance.accessUrl,
    derivedFrom: [],
  });

  const scene = await SatelliteSceneModel.findOneAndUpdate(
    // Scoped to the investigation: matching on productId alone moved an existing scene to
    // whichever investigation ingested it last, rather than creating its own record.
    { productId: ing.product_id, investigationId: new Types.ObjectId(input.investigationId) },
    {
      $set: {
        investigationId: new Types.ObjectId(input.investigationId),
        platform: ing.platform || 'OTHER',
        sensor: 'SAR-C',
        productId: ing.product_id,
        mode: ing.mode,
        polarisations: ing.polarisations,
        orbitDirection: ing.orbit_direction,
        acquiredAt: new Date(ing.acquired_at),
        footprint,
        crs: ing.crs,
        gsdMeters: ing.pixel_size_m,
        storage: {
          bucket: ing.bucket,
          key: ing.cog_keys.vv ?? Object.values(ing.cog_keys)[0],
          cogKey: ing.cog_keys.vv ?? Object.values(ing.cog_keys)[0],
          sizeBytes: ing.size_bytes,
        },
        // The provider's own record, kept verbatim (01_PRD FR-1.4).
        stacItem: {
          collection: ing.collection,
          id: ing.product_id,
          validPixelFraction: ing.valid_pixel_fraction,
          cogKeys: ing.cog_keys,
        },
        processing: {
          chain: [
            {
              step: 'WINDOWED_READ_AND_COG',
              tool: 'rasterio/rio-cogeo',
              params: { aoi: ing.aoi_bounds, pixelSizeM: ing.pixel_size_m },
              at: new Date(),
            },
          ],
          preprocessing: ing.preprocessing,
        },
        status: 'READY',
        provenance: {
          sourceType: 'SATELLITE_SCENE',
          provider: ing.provenance.provider,
          datasetId: ing.provenance.datasetId,
          externalId: ing.provenance.externalId,
          retrievedAt: new Date(ing.provenance.retrievedAt),
          licence: ing.provenance.licence,
          accessUrl: ing.provenance.accessUrl,
          derivedFrom: [new Types.ObjectId(sceneProvenanceId)],
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ── 2 · detect ────────────────────────────────────────────────────
  await progress(65, 'DETECTION', 'Running dark-feature detection');
  const cogKey = ing.cog_keys.vv ?? Object.values(ing.cog_keys)[0]!;
  const det = await callMl<MlDetectResponse>('/detect', { bucket: ing.bucket, key: cogKey });

  await progress(85, 'PERSIST', `Recording ${det.detections.length} detections`);

  // Detections are DERIVED from the scene: their provenance points at the scene's record,
  // so the lineage chain from a candidate vessel back to a provider product is unbroken.
  const detectionIds: string[] = [];
  const triaged: Array<{ id: string; triage: TriageAssessment }> = [];
  for (const d of det.detections) {
    if (!d.geometry || d.geometry.type !== 'Polygon') continue;

    const geometry = rewindPolygon(d.geometry);
    // Hoisted out of the document literal because triage ranks on it: the queue must be
    // ordered by the same geodesic area that becomes evidence, not the pixel-count estimate.
    const areaKm2 = geodesicPolygonAreaKm2(geometry) as number;

    const triage = assessTriage({
      areaKm2,
      elongationRatio: d.morphology.elongationRatio,
      // The detector reports contrast against the local sea background; it is the only
      // direct physical measurement of the observation available on this path.
      contrastDb: Number.isFinite(d.backscatter?.contrastDb) ? d.backscatter.contrastDb : null,
      lookAlikeRisk: Number.isFinite(d.lookAlikeRisk) ? d.lookAlikeRisk : null,
    });

    const autoReview = evaluateAutoReview({
      overallConfidence: d.confidence,
      lookAlikeRisk: d.lookAlikeRisk,
      areaKm2,
    });

    const doc = await SpillDetectionModel.create({
      sceneId: scene._id,
      investigationId: new Types.ObjectId(input.investigationId),
      geometry,
      // Recomputed geodesically on our side rather than trusting the pixel-count figure, so
      // the number that becomes evidence comes from the same routine as every other
      // measurement in the system (02_TRD TR-3).
      areaKm2,
      perimeterKm: d.perimeterKm,
      morphology: {
        majorAxisKm: d.morphology.majorAxisKm,
        minorAxisKm: d.morphology.minorAxisKm,
        elongationRatio: d.morphology.elongationRatio,
        orientationDeg: d.morphology.orientationDeg,
        convexity: d.morphology.convexity,
      },
      model: {
        name: det.detector.name,
        version: det.detector.version,
        artefactSha256: 'n/a-classical-detector',
        inputBands: ['VV'],
        tileSize: 0,
        overlap: 0,
      },
      confidence: {
        meanOilProbability: d.confidence,
        minOilProbability: d.confidence,
        maxOilProbability: d.confidence,
        lookAlikeCompetition: d.lookAlikeRisk,
        windSuitability: 0.5,
        overall: d.confidence,
      },
      classCounts: { sea_surface: 0, oil_spill: 0, look_alike: 0, ship: 0, land: 0 },
      maskKey: cogKey,
      probabilityKey: cogKey,
      reviewStatus: autoReview.status,
      triage: {
        ...triage,
        inputs: { ...triage.inputs, areaKm2 },
        precomputeRequested: autoReview.autoTriggerPipeline,
        assessedAt: new Date(),
      },
      provenance: {
        sourceType: 'DERIVED',
        provider: 'VARUNA',
        datasetId: `${det.detector.name}@${det.detector.version}`,
        externalId: `detect:${ing.product_id}:${d.rank}`,
        retrievedAt: new Date(),
        licence: 'internal',
        derivedFrom: [new Types.ObjectId(sceneProvenanceId)],
      },
    });
    detectionIds.push(String(doc._id));
    triaged.push({ id: String(doc._id), triage });

    if (autoReview.autoTriggerPipeline) {
      await enqueue({
        queue: 'drift',
        kind: 'DRIFT',
        jobKey: `drift:${input.investigationId}:${doc._id}`,
        payload: {
          investigationId: input.investigationId,
          detectionId: String(doc._id),
          horizonHours: 24,
          particleCount: 5000,
          chainScoring: true,
        },
        investigationId: input.investigationId,
      });
    }
  }

  // ── 3 · speculative precompute ────────────────────────────────────
  const precomputed = await precomputeOrigins(input.investigationId, triaged);

  await progress(100, 'COMPLETE');
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  logger.info(
    {
      productId: ing.product_id,
      detections: detectionIds.length,
      precomputed: precomputed.length,
      seconds,
    },
    'ingest + detection complete',
  );

  return {
    sceneId: String(scene._id),
    productId: ing.product_id,
    detectionIds,
    detectionCount: detectionIds.length,
    precomputedDetectionIds: precomputed,
    seconds,
  };
}

/**
 * Enqueue back-tracking for the detections most likely to be opened first — 08_APP_FLOW §8.2.
 *
 * This is the whole latency win, and it is deliberately the ONLY thing the pipeline does on
 * its own. Computing where a slick drifted from is not the same act as deciding the slick is
 * real: the first is arithmetic over ocean currents, the second is an accusation. So the work
 * runs ahead of the analyst and the verdict waits for them — every detection here is still
 * UNREVIEWED when the job is queued, and still UNREVIEWED when it finishes.
 *
 * Correlation is not enqueued here. It needs an `originEstimateId` that does not exist until
 * back-tracking has finished, so the drift processor chains it (see processors/drift.ts).
 *
 * A failure to enqueue is logged and swallowed. Precompute is an optimisation; a Redis blip
 * must not fail an ingest that has already written a scene, its provenance and its detections.
 */
async function precomputeOrigins(
  investigationId: string,
  triaged: Array<{ id: string; triage: TriageAssessment }>,
): Promise<string[]> {
  const selected = selectForPrecompute(triaged);
  if (selected.length === 0) return [];

  const queued: string[] = [];
  for (const detectionId of selected) {
    try {
      // The same key the analyst-triggered route uses, so a later manual "run back-tracking"
      // on this detection deduplicates against the speculative run instead of repeating it.
      await enqueue({
        queue: 'drift',
        kind: 'DRIFT',
        jobKey: `drift:${investigationId}:${detectionId}`,
        payload: {
          investigationId,
          detectionId,
          horizonHours: 24,
          particleCount: 5000,
          // Chain correlation once an origin exists, so the dossier is complete on arrival.
          chainScoring: true,
        },
        investigationId,
      });
      queued.push(detectionId);
    } catch (err) {
      logger.error(
        { err, detectionId, investigationId },
        'speculative drift enqueue failed — the detection is unaffected and can be run manually',
      );
    }
  }

  if (queued.length > 0) {
    await SpillDetectionModel.updateMany(
      { _id: { $in: queued.map((id) => new Types.ObjectId(id)) } },
      { $set: { 'triage.precomputeRequested': true } },
    );

    // One entry for the scene rather than one per detection: the useful question later is
    // "what did the system decide to compute without being asked?", and that is a list.
    await audit({
      action: 'ORIGIN_PRECOMPUTE_ENQUEUED',
      entityType: 'Investigation',
      entityId: investigationId,
      after: {
        detectionIds: queued,
        consideredCount: triaged.length,
        note: 'Speculative back-tracking. No detection review status was changed.',
      },
    });
  }

  return queued;
}
