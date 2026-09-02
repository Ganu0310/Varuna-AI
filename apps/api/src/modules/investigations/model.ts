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
    /**
     * `CASE` is every investigation an analyst ever sees or creates by hand.
     * `SWEEP_CONTAINER` is the other kind: one persistent, internal document per Discover
     * watch region that the sweep job ingests real scenes into before anyone has opened a
     * case (06_BACKEND §6.4.10). It is a real Mongoose document — same schema, same
     * collection — so the ingest pipeline that already writes scenes and detections against
     * an `investigationId` needs no changes at all to serve it.
     *
     * Filter with `REAL_CASE_FILTER` below, never `{ kind: 'CASE' }`. A Mongoose `default`
     * applies only to documents written AFTER it was added, so every investigation that
     * existed before this field did has NO `kind` at all — and `{ kind: 'CASE' }` does not
     * match a missing field. Requiring the good value hid every pre-existing case from the
     * list, the dashboard and the globe at once; excluding the bad one cannot.
     */
    kind: { type: String, enum: ['CASE', 'SWEEP_CONTAINER'], default: 'CASE', index: true },
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

/**
 * Every real case, and nothing Discover's sweep created — spread into any query that lists
 * or counts investigations for a person.
 *
 * Written as "not a container" rather than "is a case" on purpose: see the `kind` field's
 * own comment. A sweep container ALWAYS has `kind` set explicitly at creation, so excluding
 * that one value is exact, while requiring `'CASE'` silently drops every document written
 * before the field existed.
 */
export const REAL_CASE_FILTER = { kind: { $ne: 'SWEEP_CONTAINER' } } as const;
