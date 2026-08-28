import { Schema, model, type InferSchemaType } from 'mongoose';
import { provenancePlugin } from '../../db/plugins/provenance.js';
import { TIERS } from '@varuna/shared';

/** CandidateVessel — 02_TRD §2.4.7, 06_BACKEND §6.3.3, 07_AIML §7.5. */

const FeatureContributionSchema = new Schema(
  {
    key: { type: String, required: true },
    rawValue: { type: Number, default: null },
    rawUnit: String,
    normalised: { type: Number, default: null },
    weight: { type: Number, required: true },
    contribution: { type: Number, default: null },
    status: { type: String, enum: ['MEASURED', 'MISSING', 'NOT_APPLICABLE'], required: true },
    evidenceRefs: [{ kind: String, id: String, at: Date }],
  },
  { _id: false },
);

const CandidateVesselSchema = new Schema(
  {
    investigationId: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: true,
      index: true,
    },
    detectionId: { type: Schema.Types.ObjectId, ref: 'SpillDetection', required: true },
    originEstimateId: { type: Schema.Types.ObjectId, ref: 'OriginEstimate', required: true },
    trackId: { type: Schema.Types.ObjectId, ref: 'VesselTrack', required: true },
    mmsi: { type: Number, required: true, index: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    scoreCI: { type: [Number], validate: (v: number[]) => v.length === 2 },
    /**
     * Set when the unperturbed score fell outside the resampled percentile range because a
     * feature sits at its boundary. Stored, not just logged: the report and the candidate
     * panel both surface it, and an interval that was widened without saying so would be a
     * quieter version of the incoherence it fixes.
     */
    scoreCiBoundaryEffect: { type: String, default: null },
    tier: { type: String, enum: TIERS, required: true },
    rank: { type: Number, required: true },
    features: { type: [FeatureContributionSchema], required: true },
    // Renormalisation is over MEASURED features only; < 6 forces INSUFFICIENT_EVIDENCE
    // regardless of score (07_AIML §7.5.2, 12 F-14).
    measuredFeatureCount: { type: Number, required: true },
    weightProfileId: { type: String, required: true },
    modelVersion: { type: String, required: true },
    calibrated: { type: Boolean, required: true },
    excluded: {
      type: new Schema(
        { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, reason: String },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true, collection: 'candidate_vessels' },
);

CandidateVesselSchema.plugin(provenancePlugin);
CandidateVesselSchema.index({ investigationId: 1, rank: 1 });

export type CandidateVessel = InferSchemaType<typeof CandidateVesselSchema>;
export const CandidateVesselModel = model('CandidateVessel', CandidateVesselSchema);
