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
 * ASF DAAC (Alaska Satellite Facility) — 11_API_KEYS A3, 10_DATASETS §10.3.1.
 * Third in the satellite chain. The GeoJSON search endpoint needs no credential; NASA
 * Earthdata login is only required to DOWNLOAD, so search works whenever the chain reaches
 * it, and we surface that distinction rather than claiming the provider is unusable.
 *
 * Note (11_API_KEYS A3): a 401 on download with valid credentials almost always means an
 * unaccepted EULA in the Earthdata profile, not a code fault.
 */
const ASF_SEARCH = 'https://api.daac.asf.alaska.edu/services/search/param';

interface AsfFeature {
  properties?: Record<string, unknown>;
  geometry?: Polygon;
}

export class AsfClient extends ProviderClient implements SatelliteCatalogueProvider {
  readonly name = 'ASF';

  /** Search is open; downloads need Earthdata credentials. */
  isConfigured(): boolean {
    return true;
  }

  canDownload(): boolean {
    return Boolean(env.EARTHDATA_USERNAME && env.EARTHDATA_PASSWORD);
  }

  async search(params: CatalogueSearchParams): Promise<ProviderCatalogueItem[]> {
    const wkt = polygonToWkt(params.aoi);
    const query = new URLSearchParams({
      platform: 'SENTINEL-1',
      processingLevel: 'GRD_HD',
      beamMode: 'IW',
      intersectsWith: wkt,
      start: params.from,
      end: params.to,
      output: 'geojson',
      maxResults: String(Math.min(params.limit ?? 100, 250)),
    });

    const res = await this.request(
      () => this.fetchJson<{ features?: AsfFeature[] }>(`${ASF_SEARCH}?${query.toString()}`),
      { quotaKey: 'ASF:download', cost: 0 }, // searching does not consume the download quota
    );

    return (res.features ?? [])
      .map((f) => this.toCatalogueItem(f, params.aoi))
      .filter((i): i is ProviderCatalogueItem => i !== null);
  }

  private toCatalogueItem(f: AsfFeature, aoi: Polygon): ProviderCatalogueItem | null {
    const p = f.properties ?? {};
    const acquiredAt = (p.startTime ?? p.stopTime) as string | undefined;
    const productId = (p.sceneName ?? p.fileID) as string | undefined;
    if (!acquiredAt || !productId) return null;

    const footprint = f.geometry?.type === 'Polygon' ? f.geometry : null;
    const polarisationRaw = String(p.polarization ?? '');
    const polarisations = ['VV', 'VH', 'HH', 'HV'].filter((x) =>
      polarisationRaw.includes(x),
    ) as Array<'VV' | 'VH' | 'HH' | 'HV'>;

    const flight = String(p.flightDirection ?? '').toUpperCase();
    const mode = String(p.beamModeType ?? p.beamMode ?? '');

    return {
      productId,
      provider: this.name,
      platform: String(p.platform ?? 'SENTINEL-1').toUpperCase(),
      sensor: 'SAR-C',
      mode: mode === 'IW' || mode === 'EW' || mode === 'SM' ? mode : null,
      polarisations,
      orbitDirection: flight === 'ASCENDING' || flight === 'DESCENDING' ? flight : null,
      relativeOrbit: p.pathNumber != null ? Number(p.pathNumber) : null,
      acquiredAt: new Date(acquiredAt).toISOString(),
      footprint,
      bbox: footprint ? bboxOf(footprint) : null,
      aoiOverlapPct: aoiOverlapPct(aoi, footprint),
      cloudCoverPct: null,
      sizeBytes: p.bytes != null ? Number(p.bytes) : null,
      collection: 'SENTINEL-1',
      licence: 'Copernicus Sentinel Data — free, full and open (distributed by ASF DAAC)',
      selfHref: (p.url as string) ?? null,
      assets: p.url ? { GRD: String(p.url) } : {},
      preprocessed: false,
    };
  }
}

function polygonToWkt(polygon: Polygon): string {
  const ring = polygon.coordinates[0] ?? [];
  const coords = ring.map((pos) => `${Number(pos[0])} ${Number(pos[1])}`).join(',');
  return `POLYGON((${coords}))`;
}
