import { Schema, model, type InferSchemaType } from 'mongoose';
import { REJECTION_CATEGORY_IDS, TRIAGE_PRIORITIES } from '@varuna/shared';
import { PointSchema, PolygonSchema } from '../../db/schemas/geojson.js';
import { provenancePlugin } from '../../db/plugins/provenance.js';

/** SpillDetection — 02_TRD §2.4.3, 07_AIML §7.2.10 / §7.2.11. */

const MorphologySchema = new Schema(
  {
    majorAxisKm: Number,
    minorAxisKm: Number,
    elongationRatio: Number,
    orientationDeg: { type: Number, min: 0, max: 180 },
    convexity: { type: Number, min: 0, max: 1 },
    centroid: PointSchema,
    boundingBox: [Number],
  },
  { _id: false },
);

const ConfidenceSchema = new Schema(
  {
    meanOilProbability: { type: Number, min: 0, max: 1 },
    minOilProbability: { type: Number, min: 0, max: 1 },
    maxOilProbability: { type: Number, min: 0, max: 1 },
    lookAlikeCompetition: { type: Number, min: 0, max: 1 },
    windSuitability: { type: Number, min: 0, max: 1 },
    overall: { type: Number, min: 0, max: 1 },
    modelTerm: Number,
    separationTerm: Number,
    windTerm: Number,
    shapeTerm: Number,
  },
  { _id: false },
);

/**
 * Triage — queue ordering, never a verdict (detections/triage.ts).
 *
 * `components`, `inputs` and `reasons` are stored rather than recomputed on read, so the
 * ordering an analyst actually saw stays reconstructible after the weights change, and so the
 * numbers behind a priority sit next to the detection they ranked.
 */
const TriageSchema = new Schema(
  {
    score: { type: Number, required: true, min: 0, max: 1 },
    priority: { type: String, enum: TRIAGE_PRIORITIES, required: true },
    components: {
      significance: { type: Number, min: 0, max: 1 },
      interpretability: { type: Number, min: 0, max: 1 },
      attributability: { type: Number, min: 0, max: 1 },
    },
    inputs: {
      areaKm2: Number,
      // Nullable, not absent: the detector reporting no contrast is a fact worth recording.
      contrastDb: { type: Number, default: null },
      elongationRatio: Number,
    },
    reasons: { type: [String], default: [] },
    caveats: { type: [String], default: [] },
    precomputeRequested: { type: Boolean, default: false },
    assessedAt: { type: Date, required: true },
    policyVersion: { type: String, required: true },
  },
  { _id: false },
);

const ReviewEntrySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: {
      type: String,
      enum: ['CONFIRM', 'REJECT', 'EDIT', 'REOPEN', 'AUTO_CONFIRM', 'AUTO_REJECT'],
      required: true,
    },
    at: { type: Date, required: true },
    note: String,
    // REJECT only. Not `required` at the schema level because entries written before the
    // taxonomy existed have none and must stay readable; the API refuses a new rejection
    // without one (see review.ts).
    rejectionCategory: { type: String, enum: REJECTION_CATEGORY_IDS },
    geometryBefore: Schema.Types.Mixed,
  },
  { _id: true },
);

const SpillDetectionSchema = new Schema(
  {
    sceneId: { type: Schema.Types.ObjectId, ref: 'SatelliteScene', required: true, index: true },
    investigationId: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: true,
      index: true,
    },
    geometry: { type: PolygonSchema, required: true, index: '2dsphere' },
    areaKm2: { type: Number, required: true, min: 0 }, // geodesic
    perimeterKm: { type: Number, min: 0 },
    morphology: MorphologySchema,
    model: {
      name: String,
      version: String,
      artefactSha256: { type: String, required: true },
      inputBands: [String],
      tileSize: Number,
      overlap: Number,
    },
    confidence: ConfidenceSchema,
    classCounts: {
      sea_surface: Number,
      oil_spill: Number,
      look_alike: Number,
      ship: Number,
      land: Number,
    },
    maskKey: { type: String, required: true },
    probabilityKey: { type: String, required: true },
    reviewStatus: {
      type: String,
      enum: ['UNREVIEWED', 'AUTO_CONFIRMED', 'AUTO_REJECTED', 'CONFIRMED', 'REJECTED', 'EDITED'],
      default: 'UNREVIEWED',
    },
    /*
     * Stored beside the review status and strictly separate from it. The enum above is
     * deliberately unchanged — there is no AUTO_CONFIRMED, because the detector's measured
     * 68.2% look-alike false-positive rate makes a threshold-set verdict a coin flip wearing
     * a label (see detections/triage.ts).
     *
     * Optional: detections written before triage existed carry none and sort last.
     */
    triage: { type: TriageSchema, required: false },
    reviewHistory: { type: [ReviewEntrySchema], default: [] },
  },
  { timestamps: true, collection: 'spill_detections' },
);

SpillDetectionSchema.plugin(provenancePlugin);

export type SpillDetection = InferSchemaType<typeof SpillDetectionSchema>;
export const SpillDetectionModel = model('SpillDetection', SpillDetectionSchema);
