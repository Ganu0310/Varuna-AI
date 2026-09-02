import { describe, it, expect } from 'vitest';
import { selectScenesToIngest } from './service.js';
import type { CatalogueItem } from '../../providers/types.js';

/**
 * The whole reason for a per-tick cap: quota tracking (`../../providers/quota.ts`) is
 * call-based and shared with real investigations, with no existing per-run budget. This is
 * the one throttle Discover's sweep actually has, so it is worth testing on its own —
 * without a live provider call or a database, which is exactly why it was pulled out of
 * `sweepRegionTick` as a pure function.
 */

function item(overrides: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    productId: 'S1A_IW_GRDH_1SDV_20230115T012345_x',
    provider: 'PLANETARY_COMPUTER',
    platform: 'S1A',
    sensor: 'SAR-C',
    mode: 'IW',
    polarisations: ['VV', 'VH'],
    orbitDirection: 'ASCENDING',
    relativeOrbit: 1,
    acquiredAt: '2023-01-15T01:23:45Z',
    footprint: null,
    bbox: [34.6, 35.1, 35.1, 35.8],
    aoiOverlapPct: 100,
    cloudCoverPct: null,
    sizeBytes: null,
    collection: 'sentinel-1-rtc',
    licence: 'CC-BY-4.0',
    selfHref: null,
    assets: {},
    preprocessed: true,
    ingestible: true,
    ingestibleReason: null,
    ...overrides,
  };
}

describe('selectScenesToIngest', () => {
  it('refuses a product this pipeline cannot ingest, whatever collection it is in', () => {
    // The rule is `item.ingestible`, decided once in providers/chain.ts — NOT a collection
    // name matched here. An earlier version tested `collection === 'sentinel-1-rtc'` and so
    // silently discarded every real result: the providers serve these overpasses as raw
    // `sentinel-1-grd` / `SENTINEL-1`, and the sweep reported a quiet ocean instead.
    const out = selectScenesToIngest(
      [
        item({
          productId: 'raw-grd',
          collection: 'sentinel-1-grd',
          ingestible: false,
          ingestibleReason: 'needs SNAP correction',
        }),
      ],
      new Set(),
      10,
    );
    expect(out.toEnqueue).toHaveLength(0);
    expect(out.candidateCount).toBe(0);
    // ...but it is counted as a real overpass that existed, not as an empty sky.
    expect(out.overpassesSeen).toBe(1);
    expect(out.skippedNotIngestible).toBe(1);
  });

  it('accepts an ingestible product regardless of its collection name', () => {
    const out = selectScenesToIngest(
      [item({ productId: 'ok', collection: 'some-future-rtc-collection', ingestible: true })],
      new Set(),
      10,
    );
    expect(out.toEnqueue.map((i) => i.productId)).toEqual(['ok']);
    expect(out.skippedNotIngestible).toBe(0);
  });

  it('separates "nothing flew over" from "nothing readable flew over"', () => {
    const quiet = selectScenesToIngest([], new Set(), 10);
    expect(quiet.overpassesSeen).toBe(0);
    expect(quiet.skippedNotIngestible).toBe(0);

    const unreadable = selectScenesToIngest(
      [item({ productId: 'a', ingestible: false }), item({ productId: 'b', ingestible: false })],
      new Set(),
      10,
    );
    expect(unreadable.overpassesSeen).toBe(2);
    expect(unreadable.skippedNotIngestible).toBe(2);
    expect(unreadable.candidateCount).toBe(0);
  });

  it('skips a productId already ingested for this container, and counts it', () => {
    const out = selectScenesToIngest(
      [item({ productId: 'already-here' }), item({ productId: 'new-one' })],
      new Set(['already-here']),
      10,
    );
    expect(out.toEnqueue.map((i) => i.productId)).toEqual(['new-one']);
    expect(out.skippedAlreadyIngested).toBe(1);
  });

  it('caps at maxPerTick and reports how many were left for next time', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item({ productId: `p${i}`, acquiredAt: `2023-01-${10 + i}T00:00:00Z` }),
    );
    const out = selectScenesToIngest(items, new Set(), 3);
    expect(out.toEnqueue).toHaveLength(3);
    expect(out.skippedOverCap).toBe(4);
    expect(out.candidateCount).toBe(7);
  });

  it(
    'picks the NEWEST scenes first, not acquisition order — a lagging region should ' +
      'catch up with now, not work through a backlog',
    () => {
      const items = [
        item({ productId: 'oldest', acquiredAt: '2023-01-01T00:00:00Z' }),
        item({ productId: 'newest', acquiredAt: '2023-06-01T00:00:00Z' }),
        item({ productId: 'middle', acquiredAt: '2023-03-01T00:00:00Z' }),
      ];
      const out = selectScenesToIngest(items, new Set(), 2);
      expect(out.toEnqueue.map((i) => i.productId)).toEqual(['newest', 'middle']);
    },
  );

  it('enqueues nothing and skips nothing over budget when there is nothing new to find', () => {
    const out = selectScenesToIngest([], new Set(), 3);
    expect(out.toEnqueue).toHaveLength(0);
    expect(out.skippedAlreadyIngested).toBe(0);
    expect(out.skippedOverCap).toBe(0);
  });

  it('the already-ingested check and the cap compose correctly together', () => {
    // 5 candidates: 2 already ingested, cap of 2 among the remaining 3 -> 2 enqueued, 1 over
    // cap, 2 already-ingested. This is the exact composition a real lagging-then-caught-up
    // region tick produces.
    const items = [
      item({ productId: 'old-1', acquiredAt: '2023-01-01T00:00:00Z' }),
      item({ productId: 'old-2', acquiredAt: '2023-01-02T00:00:00Z' }),
      item({ productId: 'new-1', acquiredAt: '2023-01-03T00:00:00Z' }),
      item({ productId: 'new-2', acquiredAt: '2023-01-04T00:00:00Z' }),
      item({ productId: 'new-3', acquiredAt: '2023-01-05T00:00:00Z' }),
    ];
    const out = selectScenesToIngest(items, new Set(['old-1', 'old-2']), 2);
    expect(out.toEnqueue.map((i) => i.productId)).toEqual(['new-3', 'new-2']);
    expect(out.skippedAlreadyIngested).toBe(2);
    expect(out.skippedOverCap).toBe(1);
  });
});
