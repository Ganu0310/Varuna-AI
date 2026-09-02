import type { Polygon } from 'geojson';
import { env } from '../env.js';
import { ProviderClient } from './ProviderClient.js';
import { aoiOverlapPct, bboxOf } from './geoUtil.js';
import type {
  ProviderCatalogueItem,
  CatalogueSearchParams,
  SatelliteCatalogueProvider,
} from './types.js';

/**
 * Microsoft Planetary Computer — 11_API_KEYS A2, 10_DATASETS §10.3.1.
 *
 * Usable ANONYMOUSLY, which is why it is the primary download route and the provider we
 * can exercise before any account exists. A subscription key only raises rate limits.
 *
 * `sentinel-1-rtc` is Radiometrically Terrain Corrected — preprocessing steps 1–6 of
 * 07_AIML §7.2.4 are already applied, cutting ingest from ~12 min to ~2. Items from that
 * collection are flagged `preprocessed: true` so the ingest job knows to skip SNAP.
 */
const STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';

interface StacItem {
  id: string;
  collection?: string;
  bbox?: number[];
  geometry?: Polygon;
  properties: Record<string, unknown>;
  assets?: Record<string, { href?: string }>;
  links?: Array<{ rel: string; href: string }>;
}

interface StacResponse {
  features?: StacItem[];
  context?: { returned?: number; matched?: number };
}

export class PlanetaryComputerClient extends ProviderClient implements SatelliteCatalogueProvider {
  readonly name = 'PLANETARY_COMPUTER';

  /** Anonymous access is supported, so this provider is always available. */
  isConfigured(): boolean {
    return true;
  }

  async search(params: CatalogueSearchParams): Promise<ProviderCatalogueItem[]> {
    const collections = this.collectionsFor(params.platforms);
    if (collections.length === 0) return [];

    const body: Record<string, unknown> = {
      collections,
      intersects: params.aoi,
      datetime: `${params.from}/${params.to}`,
      limit: Math.min(params.limit ?? 100, 250),
    };

    const query: Record<string, unknown> = {};
    if (params.orbitDirection) {
      query['sat:orbit_state'] = { eq: params.orbitDirection.toLowerCase() };
    }
    if (params.maxCloudPct != null) {
      query['eo:cloud_cover'] = { lte: params.maxCloudPct };
    }
    if (Object.keys(query).length > 0) body.query = query;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.PLANETARY_COMPUTER_SUBSCRIPTION_KEY) {
      headers['Ocp-Apim-Subscription-Key'] = env.PLANETARY_COMPUTER_SUBSCRIPTION_KEY;
    }

    const res = await this.request(
      () =>
        this.fetchJson<StacResponse>(STAC_SEARCH, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      { quotaKey: 'PLANETARY_COMPUTER:catalogue' },
    );

    return (res.features ?? [])
      .map((f) => this.toCatalogueItem(f, params.aoi))
      .filter((i): i is ProviderCatalogueItem => i !== null);
  }

  private collectionsFor(platforms?: string[]): string[] {
    if (!platforms || platforms.length === 0) return ['sentinel-1-grd'];
    const out = new Set<string>();
    for (const p of platforms) {
      const u = p.toUpperCase();
      if (u.startsWith('SENTINEL-1')) {
        out.add('sentinel-1-grd');
        out.add('sentinel-1-rtc');
      } else if (u.startsWith('SENTINEL-2')) {
        out.add('sentinel-2-l2a');
      } else if (u.startsWith('LANDSAT')) {
        out.add('landsat-c2-l2');
      }
    }
    return [...out];
  }

  private toCatalogueItem(item: StacItem, aoi: Polygon): ProviderCatalogueItem | null {
    const p = item.properties ?? {};
    const acquiredAt = (p.datetime ?? p.start_datetime) as string | undefined;
    // A scene with no acquisition time cannot be correlated in time — reject rather than
    // default it (02_TRD TR-9, 01_PRD A4).
    if (!acquiredAt) return null;

    const collection = item.collection ?? 'unknown';
    const isSar = collection.startsWith('sentinel-1');
    const footprint = item.geometry?.type === 'Polygon' ? item.geometry : null;

    const polarisations = (
      Array.isArray(p['sar:polarizations']) ? (p['sar:polarizations'] as string[]) : []
    ).filter((x): x is 'VV' | 'VH' | 'HH' | 'HV' => ['VV', 'VH', 'HH', 'HV'].includes(x));

    const orbitState = p['sat:orbit_state'];
    const orbitDirection =
      orbitState === 'ascending' ? 'ASCENDING' : orbitState === 'descending' ? 'DESCENDING' : null;

    const mode = p['sar:instrument_mode'];

    return {
      productId: item.id,
      provider: this.name,
      platform: String(p.platform ?? (isSar ? 'SENTINEL-1' : 'OTHER')).toUpperCase(),
      sensor: isSar ? 'SAR-C' : collection.startsWith('sentinel-2') ? 'MSI' : 'OTHER',
      mode: mode === 'IW' || mode === 'EW' || mode === 'SM' ? mode : null,
      polarisations,
      orbitDirection,
      relativeOrbit: typeof p['sat:relative_orbit'] === 'number' ? p['sat:relative_orbit'] : null,
      acquiredAt: new Date(acquiredAt).toISOString(),
      footprint,
      bbox: (item.bbox?.length === 4
        ? (item.bbox as [number, number, number, number])
        : footprint
          ? bboxOf(footprint)
          : null) as [number, number, number, number] | null,
      aoiOverlapPct: aoiOverlapPct(aoi, footprint),
      cloudCoverPct: typeof p['eo:cloud_cover'] === 'number' ? p['eo:cloud_cover'] : null,
      sizeBytes: null, // MPC does not publish product size in the STAC item
      collection,
      licence: 'Copernicus Sentinel Data — free, full and open',
      selfHref: item.links?.find((l) => l.rel === 'self')?.href ?? null,
      assets: Object.fromEntries(
        Object.entries(item.assets ?? {})
          .filter(([, a]) => Boolean(a?.href))
          .map(([k, a]) => [k, a.href!]),
      ),
      preprocessed: collection === 'sentinel-1-rtc',
    };
  }
}
