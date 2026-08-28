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
    provenanceId: z.string(),
  })
  .nullable();

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
