import { Schema, model, type InferSchemaType } from 'mongoose';
import { PointSchema, PolygonSchema } from '../../db/schemas/geojson.js';
import { provenancePlugin } from '../../db/plugins/provenance.js';

/** OriginEstimate — 02_TRD §2.4.6, 07_AIML §7.3. */

const ForcingRefSchema = new Schema(
  {
    provider: String,
    datasetId: String,
    resolutionDeg: Number,
    temporalResolutionH: Number,
    /**
     * What the field actually spans, the variables read, and how they were sampled onto the
     * trajectory — the provenance panel and the dossier both render these verbatim.
     *
     * Stored rather than recomputed because the answer belongs to the run: re-deriving it
     * later would describe whatever the provider serves today, not what this estimate used.
     */
    coverage: String,
    variables: [String],
    depthLayer: String,
    retrievalRoute: String,
    processingMethod: String,
    medianSpeedMs: Number,
    provenanceId: { type: Schema.Types.ObjectId, ref: 'ProvenanceRecord' },
  },
  { _id: false },
);

/**
 * One line per provider the chain touched, in the order it touched them.
 *
 * A chain that falls through silently is indistinguishable from one that was never tried.
 * Keeping the record means the UI can say "CMEMS: OK" or "CMEMS: AUTH_FAILED_401, fell back
 * to HYCOM" rather than only showing whichever provider happened to answer.
 */
const ProviderAttemptSchema = new Schema(
  {
    provider: String,
    outcome: String,
    datasetId: String,
    covers: String,
    detail: String,
  },
  { _id: false },
);

const OriginEstimateSchema = new Schema(
  {
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', required: true },
    detectionId: {
      type: Schema.Types.ObjectId,
      ref: 'SpillDetection',
      required: true,
      index: true,
    },
    method: { type: String, enum: ['LAGRANGIAN_BACKTRACK', 'FOOTPRINT_PROXIMITY'], required: true },
    status: { type: String, enum: ['OK', 'DEGRADED', 'UNAVAILABLE'], required: true },
    degradationReason: { type: String, default: null },
    /**
     * Currents and wind degrade INDEPENDENTLY and the consequences differ, so one overall
     * status cannot express both. No currents means there is no drift result at all; no wind
     * means a wind-driven slick has its origin under-displaced. An analyst needs to know
     * which of those they are looking at.
     */
    currentStatus: {
      type: String,
      enum: ['OBSERVED', 'UNAVAILABLE'],
      default: 'UNAVAILABLE',
    },
    windStatus: {
      type: String,
      enum: ['OBSERVED', 'UNKNOWN', 'NOT_ATTEMPTED'],
      default: 'UNKNOWN',
    },
    windStatusReason: { type: String, default: null },
    providerAttempts: { type: [ProviderAttemptSchema], default: [] },
    forcing: {
      currents: { type: ForcingRefSchema, default: null },
      winds: { type: ForcingRefSchema, default: null },
    },
    params: {
      particleCount: Number,
      timeStepMinutes: Number,
      horizonHours: Number,
      windDriftCoefficientRange: [Number],
      ekmanDeflectionRangeDeg: [Number],
      horizontalDiffusivity: Number,
    },
    releaseWindow: {
      earliest: Date,
      latest: Date,
      mostLikelyStart: Date,
      mostLikelyEnd: Date,
      status: { type: String, enum: ['OK', 'WIDE'], default: 'OK' },
    },
    originField: {
      frames: [{ atTime: Date, gridKey: String, bounds: [Number], cellSizeDeg: Number }],
      support90: PolygonSchema,
      support50: PolygonSchema,
      centroid: PointSchema,
    },
  },
  { timestamps: true, collection: 'origin_estimates' },
);

OriginEstimateSchema.plugin(provenancePlugin);
OriginEstimateSchema.index({ 'originField.support90': '2dsphere' });

export type OriginEstimate = InferSchemaType<typeof OriginEstimateSchema>;
export const OriginEstimateModel = model('OriginEstimate', OriginEstimateSchema);
