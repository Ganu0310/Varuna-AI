import { z } from 'zod';
import { GeoPolygon } from './geojson.js';
import { Provenance } from './provenance.js';

/** 02_TRD §2.4.2, 06_BACKEND §6.3.3. */
export const ScenePlatform = z.enum([
  'SENTINEL-1A',
  'SENTINEL-1B',
  'SENTINEL-1C',
  'SENTINEL-2A',
  'SENTINEL-2B',
  'LANDSAT-8',
  'LANDSAT-9',
  'OTHER',
]);
export const SceneSensor = z.enum(['SAR-C', 'MSI', 'OLI']);
export const SceneStatus = z.enum([
  'CATALOGUED',
  'DOWNLOADING',
  'PREPROCESSING',
  'READY',
  'FAILED',
]);

export const ProcessingStep = z.object({
  step: z.string(),
  tool: z.string(),
  params: z.record(z.unknown()).default({}),
  at: z.string().datetime(),
});

export const ProcessingManifest = z.object({
  chain: z.array(ProcessingStep),
  manifestKey: z.string().optional(),
  /** e.g. 'MPC_RTC' when Planetary Computer RTC was used (07_AIML §7.2.4). */
  preprocessing: z.string().optional(),
});

export const SatelliteScene = z.object({
  _id: z.string(),
  investigationId: z.string().optional(),
  platform: ScenePlatform,
  sensor: SceneSensor,
  productId: z.string().min(1),
  mode: z.enum(['IW', 'EW', 'SM']).nullable().default(null),
  polarisations: z.array(z.enum(['VV', 'VH', 'HH', 'HV'])).default([]),
  orbitDirection: z.enum(['ASCENDING', 'DESCENDING']).nullable().default(null),
  relativeOrbit: z.number().nullable().default(null),
  acquiredAt: z.string().datetime(),
  footprint: GeoPolygon,
  crs: z.string().min(1),
  gsdMeters: z.number().positive(),
  cloudCoverPct: z.number().min(0).max(100).nullable().default(null),
  storage: z
    .object({
      bucket: z.string(),
      key: z.string().optional(),
      cogKey: z.string().optional(),
      sizeBytes: z.number().nonnegative().optional(),
      checksum: z.string().optional(),
    })
    .partial()
    .optional(),
  /** Verbatim provider STAC/OData record — never edited (01_PRD FR-1.4). */
  stacItem: z.record(z.unknown()),
  processing: ProcessingManifest.optional(),
  status: SceneStatus.default('CATALOGUED'),
  failureReason: z.string().optional(),
  provenance: Provenance,
});
export type SatelliteScene = z.infer<typeof SatelliteScene>;
