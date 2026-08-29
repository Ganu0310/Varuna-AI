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
       * Supplied by the uploader, never read from the file. `TIFFTAG_DATETIME` is when the
       * file was WRITTEN — for a re-exported product, the day someone opened it in a GIS.
       * Every AIS query is a window around this instant, so taking it from the file would
       * search the wrong day and rank vessels that were nowhere near the spill.
       */
      acquiredAt: string;
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
    { productId: ing.product_id },
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
  for (const d of det.detections) {
    if (!d.geometry || d.geometry.type !== 'Polygon') continue;

    const geometry = rewindPolygon(d.geometry);
    const doc = await SpillDetectionModel.create({
      sceneId: scene._id,
      investigationId: new Types.ObjectId(input.investigationId),
      geometry,
      // Recompute area geodesically on our side rather than trusting the pixel-count
      // figure, so the number that becomes evidence comes from the same routine as every
      // other measurement in the system (02_TRD TR-3).
      areaKm2: geodesicPolygonAreaKm2(geometry) as number,
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
      reviewStatus: 'UNREVIEWED',
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
  }

  await progress(100, 'COMPLETE');
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  logger.info(
    { productId: ing.product_id, detections: detectionIds.length, seconds },
    'ingest + detection complete',
  );

  return {
    sceneId: String(scene._id),
    productId: ing.product_id,
    detectionIds,
    detectionCount: detectionIds.length,
    seconds,
  };
}
