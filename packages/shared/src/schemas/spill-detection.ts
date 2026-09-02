import { z } from 'zod';
import { GeoPoint, GeoPolygon, GeoMultiPolygon } from './geojson.js';
import { Provenance } from './provenance.js';
import { REJECTION_CATEGORY_IDS, TRIAGE_PRIORITIES } from '../constants.js';

/** 02_TRD §2.4.3, 07_AIML §7.2.10 / §7.2.11. */

export const SlickMorphology = z.object({
  majorAxisKm: z.number().nonnegative(),
  minorAxisKm: z.number().nonnegative(),
  elongationRatio: z.number().nonnegative(),
  /** Bearing of the major axis, 0-180 (axis, so mod 180). */
  orientationDeg: z.number().min(0).max(180),
  convexity: z.number().min(0).max(1),
  centroid: GeoPoint,
  boundingBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const DetectionConfidence = z.object({
  meanOilProbability: z.number().min(0).max(1),
  minOilProbability: z.number().min(0).max(1),
  maxOilProbability: z.number().min(0).max(1),
  /** Mean prob of look_alike class inside the polygon. */
  lookAlikeCompetition: z.number().min(0).max(1),
  /** 0-1 from wind speed at acquisition (07_AIML §7.2.3). */
  windSuitability: z.number().min(0).max(1),
  /** Combined — documented formula in 07_AIML §7.2.11. Four terms exposed individually in the UI. */
  overall: z.number().min(0).max(1),
  modelTerm: z.number().min(0).max(1).optional(),
  separationTerm: z.number().min(0).max(1).optional(),
  windTerm: z.number().min(0).max(1).optional(),
  shapeTerm: z.number().min(0).max(1).optional(),
});

export const DetectionModelInfo = z.object({
  name: z.string(),
  version: z.string(),
  artefactSha256: z.string(),
  inputBands: z.array(z.string()),
  tileSize: z.number().int().positive(),
  overlap: z.number().nonnegative(),
});

export const ReviewStatus = z.enum([
  'UNREVIEWED',
  'AUTO_CONFIRMED',
  'AUTO_REJECTED',
  'CONFIRMED',
  'REJECTED',
  'EDITED',
]);

/**
 * Queue ordering, not a verdict — see TRIAGE_WEIGHTS in constants.ts for why this is a
 * separate field from `reviewStatus` and can never write to it.
 *
 * `components` and `reasons` are stored rather than recomputed on read so the ordering an
 * analyst saw remains reconstructible after a weight change, and so the numbers behind a
 * priority are auditable next to the detection they ranked.
 */
export const TriagePriorityEnum = z.enum(TRIAGE_PRIORITIES);

export const DetectionTriage = z.object({
  score: z.number().min(0).max(1),
  priority: TriagePriorityEnum,
  components: z.object({
    significance: z.number().min(0).max(1),
    interpretability: z.number().min(0).max(1),
    attributability: z.number().min(0).max(1),
  }),
  /** The measurements the components were derived from, kept for explainability. */
  inputs: z.object({
    areaKm2: z.number().nonnegative(),
    contrastDb: z.number().nullable(),
    elongationRatio: z.number().nonnegative(),
  }),
  reasons: z.array(z.string()),
  /** Whether drift + correlation were speculatively enqueued for this detection. */
  precomputeRequested: z.boolean(),
  assessedAt: z.string().datetime(),
  /** Weight-set identifier, so a re-ranked queue is distinguishable from a re-scored one. */
  policyVersion: z.string(),
});
export type DetectionTriage = z.infer<typeof DetectionTriage>;

export const ReviewEntry = z.object({
  userId: z.string(),
  action: z.enum(['CONFIRM', 'REJECT', 'EDIT', 'REOPEN', 'AUTO_CONFIRM', 'AUTO_REJECT']),
  at: z.string().datetime(),
  note: z.string().optional(),
  /**
   * Present on REJECT only, and required there. Optional in the contract because
   * rejections recorded before the taxonomy existed carry none, and a record that
   * predates a rule is not a violation of it — it is reported as UNCATEGORISED rather
   * than back-filled with a guess (see REJECTION_CATEGORIES).
   */
  rejectionCategory: z.enum(REJECTION_CATEGORY_IDS).optional(),
  geometryBefore: z.union([GeoPolygon, GeoMultiPolygon]).optional(),
});

export const SpillDetection = z.object({
  _id: z.string(),
  sceneId: z.string(),
  investigationId: z.string(),
  geometry: z.union([GeoPolygon, GeoMultiPolygon]),
  areaKm2: z.number().nonnegative(), // geodesic
  perimeterKm: z.number().nonnegative(),
  morphology: SlickMorphology,
  model: DetectionModelInfo,
  confidence: DetectionConfidence,
  classCounts: z.object({
    sea_surface: z.number().int().nonnegative(),
    oil_spill: z.number().int().nonnegative(),
    look_alike: z.number().int().nonnegative(),
    ship: z.number().int().nonnegative(),
    land: z.number().int().nonnegative(),
  }),
  maskKey: z.string(),
  probabilityKey: z.string(),
  reviewStatus: ReviewStatus.default('UNREVIEWED'),
  /** Absent on detections written before triage existed; they simply sort last. */
  triage: DetectionTriage.optional(),
  reviewHistory: z.array(ReviewEntry).default([]),
  provenance: Provenance,
});
export type SpillDetection = z.infer<typeof SpillDetection>;
