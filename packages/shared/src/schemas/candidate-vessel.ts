import { z } from 'zod';
import { Provenance } from './provenance.js';
import { TIERS } from '../constants.js';

/** 02_TRD §2.4.7, 06_BACKEND §6.3.3, 07_AIML §7.5. */

export const FeatureStatus = z.enum(['MEASURED', 'MISSING', 'NOT_APPLICABLE']);

export const EvidenceRef = z.object({
  kind: z.string(), // e.g. 'ais_fix', 'gap', 'scene'
  id: z.string(),
  at: z.string().datetime().optional(),
});

export const FeatureContribution = z.object({
  key: z.string(),
  rawValue: z.number().nullable(),
  rawUnit: z.string(),
  normalised: z.number().min(0).max(1).nullable(),
  weight: z.number(),
  /** weight * normalised, in score points. */
  contribution: z.number().nullable(),
  status: FeatureStatus,
  evidenceRefs: z.array(EvidenceRef).default([]),
});
export type FeatureContribution = z.infer<typeof FeatureContribution>;

export const CandidateVessel = z.object({
  _id: z.string(),
  investigationId: z.string(),
  detectionId: z.string(),
  originEstimateId: z.string(),
  trackId: z.string(),
  mmsi: z.number().int(),
  score: z.number().min(0).max(100),
  /** bootstrap 90% interval. */
  scoreCI: z.tuple([z.number(), z.number()]),
  /** P(this vessel ranks first) across paired resamples; null when not computed. */
  topRankShare: z.number().min(0).max(1).nullable().default(null),
  /**
   * Whether the TOP of the ranking survives redrawing the uncertain inputs. Carried on the
   * rank-1 candidate only: it describes the order, not the vessel.
   */
  separation: z
    .object({
      runnerUpMmsi: z.number().int(),
      winShare: z.number().min(0).max(1),
      meanMargin: z.number(),
      distinguishable: z.boolean(),
      iterations: z.number().int().nonnegative(),
      consideredCount: z.number().int().nonnegative(),
      verdict: z.string(),
    })
    .nullable()
    .default(null),
  tier: z.enum(TIERS),
  rank: z.number().int().positive(),
  features: z.array(FeatureContribution),
  /** Renormalisation is over MEASURED features only (07_AIML §7.5.2, 12 F-14). */
  measuredFeatureCount: z.number().int().nonnegative(),
  weightProfileId: z.string(),
  modelVersion: z.string(),
  calibrated: z.boolean(),
  excluded: z
    .object({ by: z.string(), at: z.string().datetime(), reason: z.string().min(1) })
    .nullable()
    .default(null),
  provenance: Provenance,
});
export type CandidateVessel = z.infer<typeof CandidateVessel>;

/** Result envelope for the correlation job — honest null result path (08_APP_FLOW §8.3). */
export const CorrelationResult = z.object({
  candidates: z.array(CandidateVessel),
  reason: z.enum(['OK', 'NO_AIS_COVERAGE']).default('OK'),
  sourcesQueried: z
    .array(
      z.object({
        source: z.string(),
        recordCount: z.number().int().nonnegative(),
        bboxCovered: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type CorrelationResult = z.infer<typeof CorrelationResult>;
