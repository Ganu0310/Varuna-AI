import { Schema, model, type InferSchemaType } from 'mongoose';
import { PolygonSchema } from '../../db/schemas/geojson.js';
import { provenancePlugin } from '../../db/plugins/provenance.js';

/** SatelliteScene — 02_TRD §2.4.2, 06_BACKEND §6.3.3. */
const SatelliteSceneSchema = new Schema(
  {
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', index: true },
    platform: { type: String, required: true },
    sensor: { type: String, enum: ['SAR-C', 'MSI', 'OLI'], required: true },
    productId: { type: String, required: true, unique: true },
    mode: { type: String, enum: ['IW', 'EW', 'SM', null] },
    polarisations: [{ type: String, enum: ['VV', 'VH', 'HH', 'HV'] }],
    orbitDirection: { type: String, enum: ['ASCENDING', 'DESCENDING', null] },
    relativeOrbit: Number,
    acquiredAt: { type: Date, required: true, index: true },
    footprint: { type: PolygonSchema, required: true, index: '2dsphere' },
    crs: { type: String, required: true },
    gsdMeters: { type: Number, required: true },
    cloudCoverPct: Number,
    storage: {
      bucket: String,
      key: String,
      cogKey: String,
      sizeBytes: Number,
      checksum: String,
    },
    // verbatim provider STAC/OData record — never edited (01_PRD FR-1.4)
    stacItem: { type: Schema.Types.Mixed, required: true },
    processing: {
      chain: [{ step: String, tool: String, params: Schema.Types.Mixed, at: Date }],
      manifestKey: String,
      preprocessing: String,
    },
    status: {
      type: String,
      enum: ['CATALOGUED', 'DOWNLOADING', 'PREPROCESSING', 'READY', 'FAILED'],
      default: 'CATALOGUED',
      index: true,
    },
    failureReason: String,
  },
  { timestamps: true },
);

SatelliteSceneSchema.plugin(provenancePlugin);

export type SatelliteScene = InferSchemaType<typeof SatelliteSceneSchema>;
export const SatelliteSceneModel = model('SatelliteScene', SatelliteSceneSchema);
