import { describe, it, expect } from 'vitest';
import type { Polygon } from 'geojson';
import { searchCatalogue } from './chain.js';
import { ProviderUnavailable } from '../errors.js';
import type {
  ProviderCatalogueItem,
  CatalogueSearchParams,
  SatelliteCatalogueProvider,
} from './types.js';

/**
 * Chain semantics — 06_BACKEND §6.5.1. The rule under test:
 *   a provider FAILURE advances the chain; a provider returning ZERO RESULTS does not,
 *   because an empty result is a real answer about coverage (13_REAL_DATA_POLICY §13.8).
 */
const AOI: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [80, 13],
      [80.4, 13],
      [80.4, 13.4],
      [80, 13.4],
      [80, 13],
    ],
  ],
};

const PARAMS: CatalogueSearchParams = {
  aoi: AOI,
  from: '2017-01-25T00:00:00Z',
  to: '2017-02-05T00:00:00Z',
};

function item(
  overrides: Partial<ProviderCatalogueItem> & { productId: string; provider: string },
): ProviderCatalogueItem {
  return {
    platform: 'SENTINEL-1A',
    sensor: 'SAR-C',
    mode: 'IW',
    polarisations: ['VV', 'VH'],
    orbitDirection: 'DESCENDING',
    relativeOrbit: null,
    acquiredAt: '2017-01-29T00:31:45.000Z',
    footprint: AOI,
    bbox: [80, 13, 80.4, 13.4],
    aoiOverlapPct: 100,
    cloudCoverPct: null,
    sizeBytes: null,
    collection: 'sentinel-1-grd',
    licence: 'Copernicus',
    selfHref: null,
    assets: {},
    preprocessed: false,
    ...overrides,
  };
}

function stubProvider(
  name: string,
  behaviour: { items?: ProviderCatalogueItem[]; throws?: unknown; configured?: boolean },
): SatelliteCatalogueProvider {
  return {
    name,
    isConfigured: () => behaviour.configured ?? true,
    search: async () => {
      if (behaviour.throws) throw behaviour.throws;
      return behaviour.items ?? [];
    },
  };
}

describe('searchCatalogue chain semantics', () => {
  it('merges results from every provider that answered', async () => {
    const chain = [
      stubProvider('A', { items: [item({ productId: 'SCENE_A', provider: 'A' })] }),
      stubProvider('B', { items: [item({ productId: 'SCENE_B', provider: 'B' })] }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items.map((i) => i.productId).sort()).toEqual(['SCENE_A', 'SCENE_B']);
    expect(res.providerStatus.every((s) => s.status === 'OK')).toBe(true);
  });

  it('ZERO RESULTS is reported as NO_RESULTS, not as a failure', async () => {
    const chain = [stubProvider('A', { items: [] })];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items).toHaveLength(0);
    expect(res.providerStatus[0]!.status).toBe('NO_RESULTS');
  });

  it('a genuinely empty answer is NOT masked by another provider failing', async () => {
    const chain = [
      stubProvider('A', { items: [] }),
      stubProvider('B', { throws: new ProviderUnavailable('B', 'TRANSPORT_ERROR') }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items).toHaveLength(0);
    expect(res.providerStatus.find((s) => s.provider === 'A')!.status).toBe('NO_RESULTS');
    expect(res.providerStatus.find((s) => s.provider === 'B')!.status).toBe('TIMEOUT');
  });

  it('a failing provider is visible in providerStatus while others still return data', async () => {
    const chain = [
      stubProvider('A', {
        throws: new ProviderUnavailable('A', 'CIRCUIT_OPEN', '2026-01-01T00:00:00Z'),
      }),
      stubProvider('B', { items: [item({ productId: 'SCENE_B', provider: 'B' })] }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items).toHaveLength(1);
    const a = res.providerStatus.find((s) => s.provider === 'A')!;
    expect(a.status).toBe('CIRCUIT_OPEN');
    expect(a.retryAt).toBe('2026-01-01T00:00:00Z');
  });

  it('an unconfigured provider reports NOT_CONFIGURED and is not called', async () => {
    let called = false;
    const chain = [
      {
        name: 'A',
        isConfigured: () => false,
        search: async () => {
          called = true;
          return [];
        },
      },
      stubProvider('B', { items: [item({ productId: 'SCENE_B', provider: 'B' })] }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(called).toBe(false);
    expect(res.providerStatus.find((s) => s.provider === 'A')!.status).toBe('NOT_CONFIGURED');
    expect(res.items).toHaveLength(1);
  });

  it('CHAIN EXHAUSTION throws with attempted[] and a consequence — never a fabricated result', async () => {
    const chain = [
      stubProvider('A', { throws: new ProviderUnavailable('A', 'TRANSPORT_ERROR') }),
      stubProvider('B', { throws: new ProviderUnavailable('B', 'QUOTA_EXHAUSTED') }),
    ];
    let thrown: unknown;
    try {
      await searchCatalogue(PARAMS, chain);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderUnavailable);
    const err = thrown as ProviderUnavailable;
    expect(err.attempted.map((a) => a.provider).sort()).toEqual(['A', 'B']);
    // The error states what the failure MEANS for the analyst (06_BACKEND §6.5.1).
    expect(err.consequence).toMatch(/unverified source|unavailable/i);
  });

  it('does NOT throw when at least one provider answered, even with zero results', async () => {
    const chain = [
      stubProvider('A', { items: [] }),
      stubProvider('B', { throws: new ProviderUnavailable('B', 'TRANSPORT_ERROR') }),
    ];
    await expect(searchCatalogue(PARAMS, chain)).resolves.toBeTruthy();
  });
});

describe('deduplication across providers', () => {
  const ID = 'S1A_IW_GRDH_1SDV_20170129T003132_20170129T003157_015039_01892E';

  it('keeps one record when several providers list the same product', async () => {
    const chain = [
      stubProvider('A', { items: [item({ productId: ID, provider: 'A' })] }),
      stubProvider('B', { items: [item({ productId: ID, provider: 'B' })] }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items).toHaveLength(1);
    // Chain order decides: the earlier provider wins.
    expect(res.items[0]!.provider).toBe('A');
    // Per-provider counts still report what each actually returned.
    expect(res.providerStatus.every((s) => s.count === 1)).toBe(true);
  });

  it('matches products despite the .SAFE suffix some providers append', async () => {
    const chain = [
      stubProvider('A', { items: [item({ productId: `${ID}.SAFE`, provider: 'A' })] }),
      stubProvider('B', { items: [item({ productId: ID, provider: 'B' })] }),
    ];
    expect((await searchCatalogue(PARAMS, chain)).items).toHaveLength(1);
  });

  it('a PREPROCESSED (RTC) duplicate wins regardless of chain order — it saves ~10 min of SNAP', async () => {
    const chain = [
      stubProvider('A', { items: [item({ productId: ID, provider: 'A', preprocessed: false })] }),
      stubProvider('B', { items: [item({ productId: ID, provider: 'B', preprocessed: true })] }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.provider).toBe('B');
    expect(res.items[0]!.preprocessed).toBe(true);
  });

  it('sorts results by acquisition time', async () => {
    const chain = [
      stubProvider('A', {
        items: [
          item({ productId: 'LATER', provider: 'A', acquiredAt: '2017-02-01T00:00:00.000Z' }),
          item({ productId: 'EARLIER', provider: 'A', acquiredAt: '2017-01-26T00:00:00.000Z' }),
        ],
      }),
    ];
    const res = await searchCatalogue(PARAMS, chain);
    expect(res.items.map((i) => i.productId)).toEqual(['EARLIER', 'LATER']);
  });
});
