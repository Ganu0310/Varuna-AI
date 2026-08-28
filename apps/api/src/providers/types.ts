import type { Polygon } from 'geojson';

/**
 * The single normalised shape every satellite provider is mapped onto — 06_BACKEND §6.4.3.
 *
 * Providers return wildly different records (STAC items, OData entities, ASF products).
 * Normalising here means the rest of the system, and the UI, never branch on provider.
 * Fields that a given provider genuinely does not supply are `null`, never guessed.
 */
export interface CatalogueItem {
  /** The exact provider product identifier — the field an evaluator can look up. */
  productId: string;
  provider: string;
  platform: string;
  sensor: 'SAR-C' | 'MSI' | 'OLI' | 'OTHER';
  mode: 'IW' | 'EW' | 'SM' | null;
  polarisations: Array<'VV' | 'VH' | 'HH' | 'HV'>;
  orbitDirection: 'ASCENDING' | 'DESCENDING' | null;
  relativeOrbit: number | null;
  /** UTC, from provider metadata only — never inferred. */
  acquiredAt: string;
  footprint: Polygon | null;
  bbox: [number, number, number, number] | null;
  /** Percentage of the AOI covered by this scene's footprint. Null when unknown. */
  aoiOverlapPct: number | null;
  cloudCoverPct: number | null;
  sizeBytes: number | null;
  collection: string;
  licence: string;
  selfHref: string | null;
  assets: Record<string, string>;
  /** Whether the provider already applied radiometric/terrain correction (MPC RTC). */
  preprocessed: boolean;
}

export type ProviderOutcome =
  'OK' | 'NO_RESULTS' | 'CIRCUIT_OPEN' | 'QUOTA_EXHAUSTED' | 'NOT_CONFIGURED' | 'TIMEOUT' | 'ERROR';

export interface ProviderStatus {
  provider: string;
  status: ProviderOutcome;
  count: number;
  latencyMs: number | null;
  reason?: string;
  retryAt?: string;
}

export interface CatalogueSearchParams {
  aoi: Polygon;
  from: string;
  to: string;
  platforms?: string[];
  orbitDirection?: 'ASCENDING' | 'DESCENDING';
  polarisation?: string;
  maxCloudPct?: number;
  limit?: number;
}

export interface CatalogueSearchResult {
  items: CatalogueItem[];
  providerStatus: ProviderStatus[];
}

/** A satellite catalogue provider. */
export interface SatelliteCatalogueProvider {
  readonly name: string;
  isConfigured(): boolean;
  search(params: CatalogueSearchParams): Promise<CatalogueItem[]>;
}
