import { z } from 'zod';
import { GeoPoint } from './geojson.js';
import { AIS_SOURCES } from '../constants.js';

/**
 * AisPosition — MongoDB **time-series** collection.
 * timeField: 't', metaField: 'meta', granularity: 'seconds'  (02_TRD §2.4.4 / §2.5.2).
 *
 * Time-series collections are append-only by nature (no updateOne on arbitrary fields, no
 * unique indexes). Deduplication happens at ingest time using a Redis-backed seen-set keyed
 * by `${mmsi}:${tSeconds}:${lat5}:${lon5}` (06_BACKEND §6.3.3).
 *
 * Sentinel values (SOG 102.3, COG 360.0, HDG 511) MUST be null here, never numbers
 * (10_DATASETS §10.4.6).
 */
export const AisPosition = z.object({
  t: z.string().datetime(),
  meta: z.object({
    mmsi: z.number().int(),
    source: z.enum(AIS_SOURCES),
    ingestBatchId: z.string(),
  }),
  position: GeoPoint,
  sog: z.number().nonnegative().nullable(), // knots
  cog: z.number().min(0).max(360).nullable(), // degrees true
  heading: z.number().min(0).max(360).nullable(),
  rot: z.number().nullable(),
  navStatus: z.number().int().nullable(), // ITU-R M.1371 code
  draught: z.number().nonnegative().nullable(),
  quality: z.object({
    flags: z.array(z.string()).default([]),
    impliedSpeedKn: z.number().nullable().default(null),
  }),
});
export type AisPosition = z.infer<typeof AisPosition>;

/** Lean shape returned by the envelope query (06_BACKEND §6.4.7). */
export const AisPositionLean = z.object({
  t: z.string().datetime(),
  meta: z.object({ mmsi: z.number().int() }),
  position: GeoPoint,
  sog: z.number().nullable(),
  cog: z.number().nullable(),
  navStatus: z.number().int().nullable(),
});
export type AisPositionLean = z.infer<typeof AisPositionLean>;

/** Canonical AIS field reference — 10_DATASETS §10.4.6. */
export const CanonicalAisRecord = z.object({
  mmsi: z.number().int(),
  t: z.string().datetime(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  sog: z.number().nullable(),
  cog: z.number().nullable(),
  heading: z.number().nullable(),
  navStatus: z.number().int().nullable(),
  imo: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  callsign: z.string().nullable().optional(),
  shipType: z.number().int().nullable().optional(),
  draught: z.number().nullable().optional(),
  destination: z.string().nullable().optional(),
  eta: z.string().nullable().optional(),
});
export type CanonicalAisRecord = z.infer<typeof CanonicalAisRecord>;
