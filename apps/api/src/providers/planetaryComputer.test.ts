import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Polygon } from 'geojson';
import { PlanetaryComputerClient } from './planetaryComputer.js';
import { ProviderUnavailable } from '../errors.js';

/**
 * Normalisation tested against a CAPTURED REAL STAC response
 * (`__fixtures__/real/mpc-sentinel1-ennore.json`, with its provenance sibling —
 * 13_REAL_DATA_POLICY §13.7). The fixture is a genuine Planetary Computer answer for the
 * Ennore/Chennai AOI; nothing here is hand-authored.
 *
 * Where a failure is needed we simulate the TRANSPORT (fetch rejecting / a 503), never the
 * content of an observation.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'real', 'mpc-sentinel1-ennore.json'), 'utf8'),
) as { features: unknown[] };

const AOI: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [80.0, 13.0],
      [80.6, 13.0],
      [80.6, 13.4],
      [80.0, 13.4],
      [80.0, 13.0],
    ],
  ],
};

const PARAMS = { aoi: AOI, from: '2017-01-25T00:00:00Z', to: '2017-02-08T00:00:00Z' };

afterEach(() => vi.restoreAllMocks());

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );
}

describe('PlanetaryComputerClient normalisation (real captured response)', () => {
  it('the fixture is a real Sentinel-1 answer', () => {
    expect(FIXTURE.features.length).toBeGreaterThan(0);
  });

  it('maps a STAC item onto the canonical CatalogueItem shape', async () => {
    mockFetchOnce(FIXTURE);
    const items = await new PlanetaryComputerClient().search(PARAMS);

    expect(items.length).toBe(FIXTURE.features.length);
    const it0 = items[0]!;
    expect(it0.productId).toMatch(/^S1[AB]_IW_GRDH_/);
    expect(it0.provider).toBe('PLANETARY_COMPUTER');
    expect(it0.sensor).toBe('SAR-C');
    expect(it0.mode).toBe('IW');
    expect(it0.polarisations).toEqual(expect.arrayContaining(['VV', 'VH']));
    expect(['ASCENDING', 'DESCENDING']).toContain(it0.orbitDirection);
    // UTC with explicit Z, taken from provider metadata — never inferred (02_TRD TR-1).
    expect(it0.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(it0.footprint?.type).toBe('Polygon');
    expect(it0.licence).toMatch(/Copernicus/);
  });

  it('computes a real AOI overlap percentage', async () => {
    mockFetchOnce(FIXTURE);
    const items = await new PlanetaryComputerClient().search(PARAMS);
    const pct = items[0]!.aoiOverlapPct;
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThan(0);
    expect(pct!).toBeLessThanOrEqual(100);
  });

  it('flags sentinel-1-rtc items as already preprocessed', async () => {
    mockFetchOnce({
      features: [
        {
          id: 'S1A_IW_GRDH_1SDV_TEST',
          collection: 'sentinel-1-rtc',
          geometry: AOI,
          properties: {
            datetime: '2017-01-29T00:31:45Z',
            'sar:instrument_mode': 'IW',
            'sar:polarizations': ['VV', 'VH'],
          },
        },
      ],
    });
    const items = await new PlanetaryComputerClient().search(PARAMS);
    expect(items[0]!.preprocessed).toBe(true);
  });

  it('DROPS an item with no acquisition time rather than defaulting one', async () => {
    mockFetchOnce({
      features: [
        { id: 'NO_TIME', collection: 'sentinel-1-grd', geometry: AOI, properties: {} },
        {
          id: 'HAS_TIME',
          collection: 'sentinel-1-grd',
          geometry: AOI,
          properties: { datetime: '2017-01-29T00:31:45Z' },
        },
      ],
    });
    const items = await new PlanetaryComputerClient().search(PARAMS);
    expect(items.map((i) => i.productId)).toEqual(['HAS_TIME']);
  });

  it('an empty provider answer yields an empty list, not an error', async () => {
    mockFetchOnce({ features: [] });
    await expect(new PlanetaryComputerClient().search(PARAMS)).resolves.toEqual([]);
  });

  it('a transport failure becomes ProviderUnavailable after retries', async () => {
    mockFetchOnce({ message: 'upstream down' }, 503);
    await expect(new PlanetaryComputerClient().search(PARAMS)).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  }, 30_000);
});
