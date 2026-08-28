import { Schema, model, type InferSchemaType } from 'mongoose';
import { LineStringSchema, PointSchema } from '../../db/schemas/geojson.js';
import { provenancePlugin } from '../../db/plugins/provenance.js';
import { AIS_QUALITY_FLAGS } from '@varuna/shared';

/**
 * `ais_positions` is a MongoDB **time-series** collection created explicitly in
 * db/bootstrap.ts (NOT via a Mongoose model — Mongoose cannot create timeseries collections
 * or their special indexes). 02_TRD §2.5.2, 06_BACKEND §6.3.3.
 *
 * This file defines the standard collections: `vessels` (static identity) and
 * `vessel_tracks` (reconstructed per investigation).
 */

const VesselSchema = new Schema(
  {
    mmsi: { type: Number, required: true, unique: true },
    imo: { type: Number, index: true, sparse: true },
    name: String,
    callsign: String,
    shipType: Number,
    shipTypeLabel: String,
    flag: String,
    dimensions: {
      toBow: Number,
      toStern: Number,
      toPort: Number,
      toStarboard: Number,
      lengthM: Number,
      beamM: Number,
    },
  },
  { timestamps: true },
);
VesselSchema.plugin(provenancePlugin);
VesselSchema.index({ name: 'text' });

const SegmentSchema = new Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    pointCount: Number,
    geometry: { type: LineStringSchema, required: true },
    lengthKm: Number,
    meanSogKn: Number,
    maxSogKn: Number,
  },
  { _id: false },
);

const GapSchema = new Schema(
  {
    startAt: Date,
    endAt: Date,
    durationMin: Number,
    fromPoint: PointSchema,
    toPoint: PointSchema,
    straightLineKm: Number,
    impliedSpeedKn: Number,
    overlapsOriginZone: Boolean,
  },
  { _id: false },
);

const VesselTrackSchema = new Schema(
  {
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', required: true },
    mmsi: { type: Number, required: true, index: true },
    imo: Number,
    name: String,
    callsign: String,
    shipType: Number,
    shipTypeLabel: String,
    flag: String,
    dimensions: Schema.Types.Mixed,
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    segments: { type: [SegmentSchema], default: [] },
    gaps: { type: [GapSchema], default: [] },
    quality: {
      flags: [{ type: String, enum: AIS_QUALITY_FLAGS }],
      completeness: { type: Number, min: 0, max: 1 },
      medianSamplingIntervalSec: Number,
      removedOutlierCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);
VesselTrackSchema.plugin(provenancePlugin);
VesselTrackSchema.index({ investigationId: 1, mmsi: 1 });
VesselTrackSchema.index({ 'segments.geometry': '2dsphere' });

export type Vessel = InferSchemaType<typeof VesselSchema>;
export type VesselTrack = InferSchemaType<typeof VesselTrackSchema>;
export const VesselModel = model('Vessel', VesselSchema);
export const VesselTrackModel = model('VesselTrack', VesselTrackSchema);
