import { describe, it, expect } from 'vitest';
import { TRIAGE_PRECOMPUTE } from '@varuna/shared';
import { assessTriage, selectForPrecompute, type TriageInput } from './triage.js';

/**
 * Triage is a queue ordering, and the tests that matter are the ones that pin what it must
 * NOT become — 07_AIML §9.
 *
 * The first group is ordinary arithmetic. The second group is the design: no threshold in
 * here may ever produce a verdict, and the detector's look-alike channel may never move a
 * rank, because held-out evaluation measured it at a 68.2% false-positive rate with a mean
 * self-reported risk of 0.259 on those very errors. Those tests are the reason the module
 * exists in this shape, so they are asserted directly rather than left to review.
 */

const BASE: TriageInput = {
  areaKm2: 1.2,
  elongationRatio: 3.0,
  contrastDb: 6.5,
  lookAlikeRisk: 0.24,
};

const at = (o: Partial<TriageInput>): TriageInput => ({ ...BASE, ...o });

describe('triage components', () => {
  it('scores a large, high-contrast, linear slick above a small, faint, round one', () => {
    const strong = assessTriage(at({ areaKm2: 8, contrastDb: 9.5, elongationRatio: 4 }));
    const weak = assessTriage(at({ areaKm2: 0.06, contrastDb: 1.2, elongationRatio: 1.05 }));
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.priority).toBe('HIGH');
    expect(weak.priority).toBe('LOW');
  });

  it('saturates area rather than letting one enormous slick dominate the queue forever', () => {
    const ten = assessTriage(at({ areaKm2: 10 }));
    const thousand = assessTriage(at({ areaKm2: 1000 }));
    expect(thousand.components.significance).toBeCloseTo(ten.components.significance, 5);
  });

  it('gives diminishing returns — 0.05→0.5 km² outweighs the larger 9→10 km² step', () => {
    // The property the curve exists for: near the detector's minimum area an extra half a
    // square kilometre changes what the slick is, and near saturation a whole one does not.
    const s = (areaKm2: number) => assessTriage(at({ areaKm2 })).components.significance;
    expect(s(0.5) - s(0.05)).toBeGreaterThan(s(10) - s(9));
  });

  it('treats an unreported contrast as unknown (0.5), never as good', () => {
    const unknown = assessTriage(at({ contrastDb: null }));
    expect(unknown.components.interpretability).toBe(0.5);
    expect(unknown.components.interpretability).toBeLessThan(
      assessTriage(at({ contrastDb: 10 })).components.interpretability,
    );
    expect(unknown.reasons.join(' ')).toContain('not assumed good');
  });

  it('keeps every component and the score inside 0-1 for degenerate input', () => {
    for (const input of [
      at({ areaKm2: 0, elongationRatio: 0, contrastDb: 0 }),
      at({ areaKm2: -5, elongationRatio: -1, contrastDb: -40 }),
      at({ areaKm2: Number.NaN, elongationRatio: Number.NaN, contrastDb: Number.NaN }),
      at({ areaKm2: Infinity, elongationRatio: Infinity, contrastDb: Infinity }),
    ]) {
      const t = assessTriage(input);
      expect(t.score).toBeGreaterThanOrEqual(0);
      expect(t.score).toBeLessThanOrEqual(1);
      for (const v of Object.values(t.components)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the look-alike channel never moves a rank', () => {
  it('produces an identical score across the full risk range', () => {
    const scores = [0, 0.15, 0.259, 0.5, 0.9, 1].map(
      (lookAlikeRisk) => assessTriage(at({ lookAlikeRisk })).score,
    );
    expect(new Set(scores).size).toBe(1);
  });

  it('surfaces the risk as a caveat that says why it is not weighted', () => {
    const t = assessTriage(at({ lookAlikeRisk: 0.31 }));
    const caveats = t.caveats.join(' ');
    expect(caveats).toContain('0.31');
    expect(caveats).toContain('68.2%');
    expect(caveats).toContain('0.259');
  });

  it('still records the "stays UNREVIEWED" caveat when the detector reports no risk', () => {
    const t = assessTriage(at({ lookAlikeRisk: null }));
    expect(t.caveats.join(' ')).toContain('UNREVIEWED');
  });
});

describe('triage cannot adjudicate', () => {
  it('exposes no review status on any assessment, at any score', () => {
    for (const areaKm2 of [0, 0.05, 1, 50, 1e6]) {
      const t = assessTriage(at({ areaKm2, contrastDb: 40, elongationRatio: 99 }));
      expect(t).not.toHaveProperty('reviewStatus');
      expect(JSON.stringify(t)).not.toMatch(/AUTO_(CONFIRMED|REJECTED)|\bCONFIRMED\b|\bREJECTED\b/);
    }
  });

  it('stamps a policy version, so a re-ranked queue is distinguishable from a re-scored one', () => {
    expect(assessTriage(BASE).policyVersion).toBe('TRIAGE_V1');
  });
});

describe('precompute selection', () => {
  const withScore = (id: string, input: Partial<TriageInput>) => ({
    id,
    triage: assessTriage(at(input)),
  });

  it('takes the highest scoring detections first and caps the number per scene', () => {
    const items = [
      withScore('small', { areaKm2: 0.08, contrastDb: 2, elongationRatio: 1.1 }),
      withScore('big', { areaKm2: 9, contrastDb: 9, elongationRatio: 4 }),
      withScore('medium', { areaKm2: 2, contrastDb: 6, elongationRatio: 2.5 }),
    ];
    expect(selectForPrecompute(items, 2)).toEqual(['big', 'medium']);
  });

  it('never queues a detection below the precompute floor', () => {
    const floor = assessTriage(at({ areaKm2: 0, contrastDb: 0, elongationRatio: 0 }));
    expect(floor.score).toBeLessThan(TRIAGE_PRECOMPUTE.minScore);
    expect(floor.eligibleForPrecompute).toBe(false);
    expect(selectForPrecompute([{ id: 'x', triage: floor }])).toEqual([]);
  });

  it('breaks ties on detector rank, so re-ingesting a scene picks the same detections', () => {
    const identical = [withScore('rank0', {}), withScore('rank1', {}), withScore('rank2', {})];
    expect(selectForPrecompute(identical, 2)).toEqual(['rank0', 'rank1']);
    expect(selectForPrecompute(identical, 2)).toEqual(['rank0', 'rank1']);
  });

  it('returns nothing rather than throwing when the cap is zero or the scene is empty', () => {
    expect(selectForPrecompute([], 5)).toEqual([]);
    expect(selectForPrecompute([withScore('a', { areaKm2: 9 })], 0)).toEqual([]);
  });
});
