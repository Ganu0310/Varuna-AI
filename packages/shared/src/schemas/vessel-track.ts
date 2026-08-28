import { z } from 'zod';
import { GeoLineString, GeoPoint } from './geojson.js';
import { Provenance } from './provenance.js';
import { AIS_QUALITY_FLAGS } from '../constants.js';

/** 02_TRD §2.4.5, 06_BACKEND §6.6.3. */

export const TrackSegment = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  pointCount: z.number().int().nonnegative(),
  geometry: GeoLineString, // ordered, EPSG:4326
  lengthKm: z.number().nonnegative(),
  meanSogKn: z.number().nonnegative(),
  maxSogKn: z.number().nonnegative(),
});

export const TrackGap = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  durationMin: z.number().nonnegative(),
  fromPoint: GeoPoint,
  toPoint: GeoPoint,
  straightLineKm: z.number().nonnegative(),
  impliedSpeedKn: z.number().nonnegative(),
  /** Whether this dark period overlaps the origin zone (01_PRD D4). */
  overlapsOriginZone: z.boolean().optional(),
});

export const VesselTrack = z.object({
  _id: z.string(),
  investigationId: z.string(),
  mmsi: z.number().int(),
  imo: z.number().int().nullable().default(null),
  name: z.string().nullable().default(null),
  callsign: z.string().nullable().default(null),
  shipType: z.number().int().nullable().default(null),
  shipTypeLabel: z.string().nullable().default(null),
  flag: z.string().nullable().default(null),
  dimensions: z
    .object({
      toBow: z.number().nullable(),
      toStern: z.number().nullable(),
      toPort: z.number().nullable(),
      toStarboard: z.number().nullable(),
      lengthM: z.number().nullable(),
      beamM: z.number().nullable(),
    })
    .nullable()
    .default(null),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  segments: z.array(TrackSegment),
  gaps: z.array(TrackGap),
  quality: z.object({
    flags: z.array(z.enum(AIS_QUALITY_FLAGS)),
    completeness: z.number().min(0).max(1),
    medianSamplingIntervalSec: z.number().nonnegative(),
    /** Removed outliers are COUNTED and surfaced, never silently dropped (06_BACKEND §6.6.3). */
    removedOutlierCount: z.number().int().nonnegative(),
  }),
  provenance: Provenance,
});
export type VesselTrack = z.infer<typeof VesselTrack>;
