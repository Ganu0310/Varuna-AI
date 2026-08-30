import { describe, it, expect } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import { rankSeparation, DISTINGUISHABLE_WIN_SHARE, SEPARATION_FIELD_SIZE } from './separation.js';
import type { CandidateInput, ScoringContext } from './features.js';

/**
 * A ranked list invites the reader to act on its order, so the question this answers is the
 * one a dossier is read for: **is the top candidate actually ahead of the second, or did the
 * estimates just land that way?**
 *
 * The property under test throughout is that the answer tracks the evidence — a vessel that
 * genuinely sits in the origin zone stays first under re-drawing, and two vessels with the
 * same evidence do not acquire an order they never had.
 */
const ZONE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [144.6, 13.4],
      [144.7, 13.4],
      [144.7, 13.5],
      [144.6, 13.5],
      [144.6, 13.4],
    ],
  ],
};

const CTX: ScoringContext = {
  originZone: ZONE,
  originCentroid: { type: 'Point', coordinates: [144.65, 13.45] },
  releaseEarliest: '2025-09-21T14:00:00Z',
  releaseLatest: '2025-09-21T20:00:00Z',
  slickOrientationDeg: 45,
  slickElongationRatio: 3.0,
  releaseWindowStatus: 'OK',
  originDegraded: false,
};

/**
 * A track of eight fixes. `lonOffset`/`latOffset` slide the whole vessel away from the
 * origin zone, which is what makes one candidate genuinely weaker than another.
 */
function candidate(mmsi: number, lonOffset = 0, latOffset = 0, gapMinutes = 0): CandidateInput {
  const base = Date.parse('2025-09-21T15:00:00Z');
  const offsets = [0, 5, 10, 15 + gapMinutes, 20 + gapMinutes, 25, 30, 35];
  const fixes = offsets.map((m, i) => ({
    t: new Date(base + m * 60_000).toISOString(),
    lon: 144.61 + i * 0.012 + lonOffset,
    lat: 13.41 + i * 0.012 + latOffset,
    sog: 9,
    cog: 45,
    heading: 45,
    navStatus: 0,
    draught: 8,
  }));
  const line: LineString = { type: 'LineString', coordinates: fixes.map((f) => [f.lon, f.lat]) };
  return { mmsi, shipType: 80, fixes, gaps: [], trackLine: line, priorIncidents: 0 };
}

describe('rank separation', () => {
  it('calls a clear leader distinguishable, and says it is about ORDER not guilt', () => {
    // One vessel through the origin zone, one a long way off it.
    const r = rankSeparation([candidate(1), candidate(2, 0.9, 0.9)], CTX, 120);

    expect(r.leader).not.toBeNull();
    expect(r.leader!.mmsi).toBe(1);
    expect(r.leader!.runnerUpMmsi).toBe(2);
    expect(r.leader!.winShare).toBeGreaterThanOrEqual(DISTINGUISHABLE_WIN_SHARE);
    expect(r.leader!.distinguishable).toBe(true);
    // The claim must never inflate into a finding of responsibility.
    expect(r.verdict).toMatch(/not about the vessel being responsible/i);
  });

  it('refuses to separate two candidates carrying identical evidence', () => {
    // THE POINT: same track, different MMSI. Any ordering between them is an artefact, and
    // a ranked list that presented one as the stronger lead would be inventing a finding.
    const r = rankSeparation([candidate(1), candidate(2)], CTX, 120);

    expect(r.leader!.distinguishable).toBe(false);
    expect(r.leader!.meanMargin).toBeCloseTo(0, 1);
    expect(r.verdict).toMatch(/NOT separable/);
    expect(r.verdict).toMatch(/Both belong in any follow-up, or neither does/);
  });

  it('flags a stable order across a margin too thin to act on', () => {
    // Consistently ahead, but barely. The dangerous case: it reads as decisive and is not.
    const r = rankSeparation([candidate(1), candidate(2, 0.004, 0.004)], CTX, 200);

    if (r.leader!.distinguishable && r.leader!.meanMargin < 2) {
      expect(r.verdict).toMatch(/the gap is not large/i);
      expect(r.verdict).toMatch(/closely-matched/);
    }
    expect(r.leader!.meanMargin).toBeLessThan(10);
  });

  it('reports how often each vessel came first, summing to the draws taken', () => {
    const r = rankSeparation([candidate(1), candidate(2), candidate(3, 0.5, 0.5)], CTX, 100);

    const total = r.topRankShare.reduce((s, x) => s + x.share, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(r.topRankShare[0]!.share).toBeGreaterThanOrEqual(r.topRankShare.at(-1)!.share);
  });

  it('is deterministic, so a dossier can be reproduced', () => {
    const field = () => [candidate(1), candidate(2, 0.2, 0.2)];
    expect(rankSeparation(field(), CTX, 60)).toEqual(rankSeparation(field(), CTX, 60));
  });

  it('resamples only the front of the field, and says how many', () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate(100 + i, i * 0.02, i * 0.02));
    const r = rankSeparation(many, CTX, 40);

    expect(r.consideredCount).toBe(SEPARATION_FIELD_SIZE);
    expect(r.note).toContain(`${SEPARATION_FIELD_SIZE} highest-scoring`);
  });

  it('a single candidate has nothing to be separated from, and says so honestly', () => {
    const r = rankSeparation([candidate(1)], CTX, 50);

    expect(r.leader).toBeNull();
    // The distinction that matters: sparse coverage is not weak evidence.
    expect(r.verdict).toMatch(/statement about the AIS coverage, not about the strength/);
  });

  it('no candidates is not an error', () => {
    const r = rankSeparation([], CTX, 50);
    expect(r.leader).toBeNull();
    expect(r.topRankShare).toEqual([]);
    expect(r.iterations).toBe(0);
  });

  it('names the shared origin draw, because that is what makes the number meaningful', () => {
    // The interval on each candidate is drawn independently; this is not, and the note has
    // to say so or a reader cannot tell the two apart.
    const r = rankSeparation([candidate(1), candidate(2, 0.3, 0.3)], CTX, 30);
    expect(r.note).toMatch(/ONCE for the whole field/);
    expect(r.note).toMatch(/Real AIS fixes are never perturbed/);
  });
});
