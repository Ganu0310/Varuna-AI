import { z } from 'zod';

/**
 * Provenance — the structural guarantee behind 13_REAL_DATA_POLICY.
 *
 * There is deliberately NO `MOCK`, `SYNTHETIC`, `FAKE`, `DEMO`, `TEST` or `PLACEHOLDER`
 * member of `sourceType`. A developer wanting to insert fabricated data has no valid value
 * to use, and adding one would be a visible, reviewable change to a policy-critical file.
 *
 * Reference: 02_TRD §2.4.1, 06_BACKEND §6.3.1, 13_REAL_DATA_POLICY §13.4 / §13.5.
 */
export const SOURCE_TYPES = [
  'SATELLITE_SCENE',
  'AIS_ARCHIVE',
  'AIS_API',
  'AIS_STREAM',
  'OCEAN_MODEL',
  'ATMOSPHERIC_MODEL',
  'COASTLINE_VECTOR',
  'VESSEL_REGISTRY',
  'HUMAN_ANNOTATION',
  'DERIVED',
] as const;

export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export const Provenance = z.object({
  sourceType: SourceType,
  /** Who distributed it, e.g. 'Copernicus Data Space Ecosystem'. */
  provider: z.string().trim().min(1),
  /** Which dataset/collection, e.g. 'SENTINEL-1' / 'GLOBAL_ANALYSISFORECAST_PHY_001_024'. */
  datasetId: z.string().trim().min(1),
  /** The identifier an evaluator can use to find the same data themselves. Load-bearing. */
  externalId: z.string().trim().min(1),
  retrievedAt: z.string().datetime(),
  /** Licence and required attribution, e.g. 'Copernicus Sentinel Data 2023'. */
  licence: z.string().trim().min(1),
  accessUrl: z.string().url().optional(),
  /** SHA-256 of the raw artefact. */
  checksum: z.string().optional(),
  /** Provenance record IDs of parents — the lineage DAG (13_REAL_DATA_POLICY §13.5.1). */
  derivedFrom: z.array(z.string()).default([]),
  processingManifestId: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Types whose documents MUST carry a valid provenance sub-document (05_FRONTEND §5.7). */
export const PROVENANCE_REQUIRED_TYPES = [
  'SatelliteScene',
  'SpillDetection',
  'VesselTrack',
  'OriginEstimate',
  'CandidateVessel',
  'Vessel',
  'AisPosition',
] as const;
export type ProvenanceRequiredType = (typeof PROVENANCE_REQUIRED_TYPES)[number];

export function hasValidProvenance(value: unknown): boolean {
  const p = (value as { provenance?: unknown })?.provenance as Partial<Provenance> | undefined;
  return Boolean(
    p?.sourceType && p.provider && p.datasetId && p.externalId && p.retrievedAt && p.licence,
  );
}
