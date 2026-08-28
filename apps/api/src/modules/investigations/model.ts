import { Schema, model, type InferSchemaType } from 'mongoose';
import { PolygonSchema } from '../../db/schemas/geojson.js';

/** Investigation lifecycle — 08_APP_FLOW §8.5.1. */
const INVESTIGATION_STATUS = [
  'DRAFT',
  'SCENES_PENDING',
  'SCENES_READY',
  'DETECTING',
  'DETECTED',
  'NO_DETECTION',
  'REVIEWED',
  'ORIGIN_ESTIMATED',
  'ORIGIN_DEGRADED',
  'CORRELATING',
  'RANKED',
  'NO_AIS',
  'REPORTED',
  'ARCHIVED',
] as const;

const MemberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['viewer', 'analyst', 'lead', 'admin'], required: true },
  },
  { _id: false },
);

const InvestigationSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', index: true },
    name: { type: String, required: true, trim: true },
    description: String,
    incidentReference: String,
    aoi: { type: PolygonSchema, required: true },
    aoiAreaKm2: { type: Number, required: true, min: 0 },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    reportedIncidentAt: Date,
    status: { type: String, enum: INVESTIGATION_STATUS, default: 'DRAFT', index: true },
    members: { type: [MemberSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: Date,
  },
  { timestamps: true },
);

InvestigationSchema.index({ orgId: 1, createdAt: -1 });
InvestigationSchema.index({ aoi: '2dsphere' });

export type Investigation = InferSchemaType<typeof InvestigationSchema>;
export const InvestigationModel = model('Investigation', InvestigationSchema);
