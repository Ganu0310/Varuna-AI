import { z } from 'zod';
import { GeoPoint, GeoPolygon } from './geojson.js';
import { Provenance } from './provenance.js';

/** 02_TRD §2.4.6, 07_AIML §7.3. */

export const OriginMethod = z.enum(['LAGRANGIAN_BACKTRACK', 'FOOTPRINT_PROXIMITY']);
export const OriginStatus = z.enum(['OK', 'DEGRADED', 'UNAVAILABLE']);

export const ForcingRef = z
  .object({
    provider: z.string(),
    datasetId: z.string(),
    resolutionDeg: z.number().positive(),
    temporalResolutionH: z.number().positive(),
    /** Temporal/spatial extent of the field that was actually read, for the provenance panel. */
    coverage: z.string().optional(),
    variables: z.array(z.string()).optional(),
    depthLayer: z.string().optional(),
    retrievalRoute: z.string().optional(),
    processingMethod: z.string().optional(),
    medianSpeedMs: z.number().optional(),
    provenanceId: z.string(),
  })
  .nullable();

/**
 * Per-term forcing status.
 *
 * `UNKNOWN` wind is never silently replaced with a constant or a climatological mean — the
 * drift run sets the wind-drift coefficient to zero and labels itself degraded, which
 * under-displaces a wind-driven slick in a direction the report states.
 */
export const CurrentStatus = z.enum(['OBSERVED', 'UNAVAILABLE']);
export const WindStatus = z.enum(['OBSERVED', 'UNKNOWN', 'NOT_ATTEMPTED']);

/** One provider the chain touched, and what came back. */
export const ProviderAttempt = z.object({
  provider: z.string(),
  outcome: z.string(),
  datasetId: z.string().optional(),
  covers: z.string().optional(),
  detail: z.string().optional(),
});

export const ReleaseWindow = z.object({
  earliest: z.string().datetime(),
  latest: z.string().datetime(),
  mostLikelyStart: z.string().datetime(),
  mostLikelyEnd: z.string().datetime(),
  status: z.enum(['OK', 'WIDE']).default('OK'),
});

export const OriginFrame = z.object({
  atTime: z.string().datetime(),
  gridKey: z.string(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  cellSizeDeg: z.number().positive(),
});

export const OriginEstimate = z.object({
  _id: z.string(),
  investigationId: z.string(),
  detectionId: z.string(),
  method: OriginMethod,
  status: OriginStatus,
  degradationReason: z.string().nullable().default(null),
  currentStatus: CurrentStatus.default('UNAVAILABLE'),
  windStatus: WindStatus.default('UNKNOWN'),
  windStatusReason: z.string().nullable().default(null),
  providerAttempts: z.array(ProviderAttempt).default([]),
  forcing: z.object({
    currents: ForcingRef,
    winds: ForcingRef,
  }),
  params: z.object({
    particleCount: z.number().int().positive(),
    timeStepMinutes: z.number().positive(),
    horizonHours: z.number().positive(),
    windDriftCoefficientRange: z.tuple([z.number(), z.number()]),
    ekmanDeflectionRangeDeg: z.tuple([z.number(), z.number()]),
    horizontalDiffusivity: z.number().nonnegative(),
  }),
  releaseWindow: ReleaseWindow,
  originField: z.object({
    frames: z.array(OriginFrame),
    support90: GeoPolygon, // 90% probability contour at mostLikely time
    support50: GeoPolygon,
    centroid: GeoPoint,
  }),
  provenance: Provenance,
});
export type OriginEstimate = z.infer<typeof OriginEstimate>;
