import type { Polygon } from 'geojson';
import { env } from '../env.js';
import { redisConnection } from '../queue/connection.js';
import { ProviderClient, ProviderHttpError } from './ProviderClient.js';
import { aoiOverlapPct, bboxOf } from './geoUtil.js';
import type {
  ProviderCatalogueItem,
  CatalogueSearchParams,
  SatelliteCatalogueProvider,
} from './types.js';

/**
 * Copernicus Data Space Ecosystem — 11_API_KEYS A1, 10_DATASETS §10.3.1.
 * The authoritative ESA distribution point. OAuth2 client-credentials; the token is cached
 * in Redis (shared across replicas) with a 60 s safety margin, never logged, and never
 * returned in an API response (06_BACKEND §6.5.2, 11_API_KEYS KEY-5).
 */
const TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const ODATA_URL = 'https://catalogue.dataspace.copernicus.eu/odata/v1/Products';
const TOKEN_CACHE_KEY = 'provider:cdse:access_token';

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface ODataProduct {
  Id: string;
  Name: string;
  ContentLength?: number;
  ContentDate?: { Start?: string };
  Footprint?: string;
  GeoFootprint?: Polygon;
  Attributes?: Array<{ Name: string; Value: unknown }>;
}

export class CdseClient extends ProviderClient implements SatelliteCatalogueProvider {
  readonly name = 'CDSE';

  isConfigured(): boolean {
    return Boolean(env.CDSE_CLIENT_ID && env.CDSE_CLIENT_SECRET);
  }

  private async getToken(): Promise<string> {
    const redis = redisConnection();
    const cached = await redis.get(TOKEN_CACHE_KEY);
    if (cached) return cached;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.CDSE_CLIENT_ID!,
        client_secret: env.CDSE_CLIENT_SECRET!,
      }),
    });
    if (!res.ok) {
      // The body may echo the client_id — never let it into a log or an error message.
      throw new ProviderHttpError(res.status, this.name, 'token exchange failed');
    }
    const json = (await res.json()) as TokenResponse;
    // 60 s safety margin so a token never expires mid-flight.
    const ttl = Math.max(30, json.expires_in - 60);
    await redis.set(TOKEN_CACHE_KEY, json.access_token, 'EX', ttl);
    return json.access_token;
  }

  async search(params: CatalogueSearchParams): Promise<ProviderCatalogueItem[]> {
    const collection = this.collectionFor(params.platforms);
    const wkt = polygonToWkt(params.aoi);

    const filters = [
      `Collection/Name eq '${collection}'`,
      `OData.CSC.Intersects(area=geography'SRID=4326;${wkt}')`,
      `ContentDate/Start gt ${params.from}`,
      `ContentDate/Start lt ${params.to}`,
    ];
    if (collection === 'SENTINEL-1') {
      filters.push(
        `Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' and att/OData.CSC.StringAttribute/Value eq 'IW_GRDH_1S')`,
      );
    }

    const url =
      `${ODATA_URL}?$filter=${encodeURIComponent(filters.join(' and '))}` +
      `&$expand=Attributes&$orderby=${encodeURIComponent('ContentDate/Start asc')}` +
      `&$top=${Math.min(params.limit ?? 100, 200)}`;

    const token = await this.request(() => this.getToken(), { retries: 1 });

    const res = await this.request(
      () =>
        this.fetchJson<{ value?: ODataProduct[] }>(url, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      { quotaKey: 'CDSE:catalogue' },
    );

    return (res.value ?? [])
      .map((p) => this.toCatalogueItem(p, params.aoi, collection))
      .filter((i): i is ProviderCatalogueItem => i !== null);
  }

  private collectionFor(platforms?: string[]): string {
    const first = platforms?.[0]?.toUpperCase() ?? 'SENTINEL-1';
    if (first.startsWith('SENTINEL-2')) return 'SENTINEL-2';
    if (first.startsWith('LANDSAT')) return 'LANDSAT-8';
    return 'SENTINEL-1';
  }

  private toCatalogueItem(
    p: ODataProduct,
    aoi: Polygon,
    collection: string,
  ): ProviderCatalogueItem | null {
    const acquiredAt = p.ContentDate?.Start;
    if (!acquiredAt) return null; // no acquisition time ⇒ unusable, never defaulted

    const attr = (name: string): unknown =>
      p.Attributes?.find((a) => a.Name === name)?.Value ?? undefined;

    const footprint = p.GeoFootprint?.type === 'Polygon' ? p.GeoFootprint : null;
    const isSar = collection === 'SENTINEL-1';

    const polarisationRaw = String(attr('polarisationChannels') ?? '');
    const polarisations = ['VV', 'VH', 'HH', 'HV'].filter((x) =>
      polarisationRaw.includes(x),
    ) as Array<'VV' | 'VH' | 'HH' | 'HV'>;

    const orbit = String(attr('orbitDirection') ?? '').toUpperCase();
    const mode = String(attr('operationalMode') ?? '');
    const cloud = attr('cloudCover');

    return {
      productId: p.Name,
      provider: this.name,
      platform: String(attr('platformShortName') ?? collection).toUpperCase(),
      sensor: isSar ? 'SAR-C' : collection === 'SENTINEL-2' ? 'MSI' : 'OTHER',
      mode: mode === 'IW' || mode === 'EW' || mode === 'SM' ? mode : null,
      polarisations,
      orbitDirection: orbit === 'ASCENDING' || orbit === 'DESCENDING' ? orbit : null,
      relativeOrbit:
        typeof attr('relativeOrbitNumber') === 'number'
          ? (attr('relativeOrbitNumber') as number)
          : null,
      acquiredAt: new Date(acquiredAt).toISOString(),
      footprint,
      bbox: footprint ? bboxOf(footprint) : null,
      aoiOverlapPct: aoiOverlapPct(aoi, footprint),
      cloudCoverPct: typeof cloud === 'number' ? cloud : null,
      sizeBytes: p.ContentLength ?? null,
      collection,
      licence: 'Copernicus Sentinel Data — free, full and open',
      selfHref: `${ODATA_URL}(${p.Id})`,
      assets: {},
      preprocessed: false, // CDSE serves raw GRD; SNAP preprocessing is required
    };
  }
}

/** GeoJSON Polygon → WKT for the OData `Intersects` filter. Outer ring only. */
function polygonToWkt(polygon: Polygon): string {
  const ring = polygon.coordinates[0] ?? [];
  const coords = ring.map((pos) => `${Number(pos[0])} ${Number(pos[1])}`).join(',');
  return `POLYGON((${coords}))`;
}
