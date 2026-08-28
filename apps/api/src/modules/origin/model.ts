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
    provenanceId: { type: Schema.Types.ObjectId, ref: 'ProvenanceRecord' },
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
