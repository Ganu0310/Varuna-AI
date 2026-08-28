import { z } from 'zod';
import { GeoPolygon } from './geojson.js';
import { MAX_WINDOW_DAYS } from '../constants.js';

/** Investigation lifecycle — 08_APP_FLOW §8.5.1. */
export const InvestigationStatus = z.enum([
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
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatus>;

/** Body for POST /investigations — 06_BACKEND §6.4.2. */
export const CreateInvestigation = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    incidentReference: z.string().trim().max(200).optional(),
    aoi: GeoPolygon,
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    /** Optional known/reported incident time — seeds the release-window prior. */
    reportedIncidentAt: z.string().datetime().optional(),
  })
  .refine((v) => new Date(v.windowEnd) > new Date(v.windowStart), {
    message: 'windowEnd must be after windowStart',
    path: ['windowEnd'],
  })
  .refine(
    (v) =>
      (new Date(v.windowEnd).getTime() - new Date(v.windowStart).getTime()) / 86_400_000 <=
      MAX_WINDOW_DAYS,
    { message: `time window must not exceed ${MAX_WINDOW_DAYS} days`, path: ['windowEnd'] },
  );
export type CreateInvestigation = z.infer<typeof CreateInvestigation>;

export const Investigation = z.object({
  _id: z.string(),
  orgId: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  incidentReference: z.string().optional(),
  aoi: GeoPolygon,
  aoiAreaKm2: z.number().nonnegative(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  reportedIncidentAt: z.string().datetime().optional(),
  status: InvestigationStatus,
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Investigation = z.infer<typeof Investigation>;
