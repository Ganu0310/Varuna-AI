import { describe, it, expect } from 'vitest';
import { buildPlainSummary } from './service.js';

/**
 * `buildPlainSummary` exists because the technical dossier assumes a reader who can evaluate
 * a confidence interval and knows what "look-alike risk" means, and most people a finding
 * eventually reaches are not that reader. So the thing worth testing is not that the prose
 * reads nicely — it is that the SAME real state the technical sections show is what drives
 * every sentence here, with no separate or softer facts, and that the mandatory closing
 * caveats actually track the conditions that make them true.
 */

const AOI = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [144.55, 13.3],
      [144.95, 13.3],
      [144.95, 13.6],
      [144.55, 13.6],
      [144.55, 13.3],
    ],
  ],
};

const INV = {
  aoi: AOI,
  windowStart: '2025-09-21T00:00:00.000Z',
  windowEnd: '2025-09-22T00:00:00.000Z',
};

function detection(overrides: Partial<{ areaKm2: number; lookAlikeCompetition: number }> = {}) {
  return {
    areaKm2: overrides.areaKm2 ?? 1,
    confidence: { lookAlikeCompetition: overrides.lookAlikeCompetition ?? 0.1 },
  };
}

function candidate(rank: number, tier: string, mmsi = 368278840 + rank) {
  return { rank, mmsi, tier };
}

describe('buildPlainSummary — headline', () => {
  it('says nothing was found when there are no detections', () => {
    const s = buildPlainSummary(INV, [], null, null, []);
    expect(s.headline).toMatch(/did not show anything/i);
  });

  it('says no vessel could be pointed to when detections exist but no candidates do', () => {
    const s = buildPlainSummary(INV, [detection()], null, null, []);
    expect(s.headline).toMatch(/could not point to any particular vessel/i);
  });

  it.each([
    ['STRONG', /one ship stands out as a strong lead/i],
    ['MODERATE', /a few ships are worth/i],
    ['WEAK', /only weak leads/i],
    ['INSUFFICIENT_EVIDENCE', /not enough information/i],
  ] as const)('reflects the top-ranked candidate tier (%s)', (tier, expected) => {
    const s = buildPlainSummary(INV, [detection()], null, null, [candidate(1, tier)]);
    expect(s.headline).toMatch(expected);
  });

  it('reads the RANK-1 candidate, not simply the first array element', () => {
    // Correlation sorts by rank, but nothing here should assume the array already is —
    // the technical dossier's own candidate table is explicitly sorted by rank for the
    // same reason.
    const s = buildPlainSummary(INV, [detection()], null, null, [
      candidate(2, 'WEAK'),
      candidate(1, 'STRONG'),
    ]);
    expect(s.headline).toMatch(/strong lead/i);
  });
});

describe('buildPlainSummary — what was seen', () => {
  it('states the real total area and a football-pitch equivalent computed from it', () => {
    // 3 detections, 1 km2 total -> 1 / 0.00714 ≈ 140 pitches. The number must be REAL
    // arithmetic on the real total, not a canned phrase.
    const s = buildPlainSummary(
      INV,
      [detection({ areaKm2: 0.5 }), detection({ areaKm2: 0.3 }), detection({ areaKm2: 0.2 })],
      null,
      null,
      [],
    );
    expect(s.whatWasSeen).toMatch(/3 dark patches/);
    expect(s.whatWasSeen).toMatch(/1(\.00)? km²/);
    expect(s.whatWasSeen).toMatch(/140 football pitches/);
  });

  it('never claims a football-pitch count below one', () => {
    const s = buildPlainSummary(INV, [detection({ areaKm2: 0.0001 })], null, null, []);
    expect(s.whatWasSeen).toMatch(/1 football pitch\b/);
  });

  it('uses singular phrasing for exactly one detection', () => {
    const s = buildPlainSummary(INV, [detection({ areaKm2: 1 })], null, null, []);
    expect(s.whatWasSeen).toMatch(/1 dark patch consistent/);
    expect(s.whatWasSeen).not.toMatch(/1 dark patches/);
  });
});

describe('buildPlainSummary — where and when', () => {
  it('computes the bounding-box centre from the real AOI ring', () => {
    // Centre of 144.55..144.95 / 13.3..13.6 is 144.75 / 13.45.
    const s = buildPlainSummary(INV, [], null, null, []);
    expect(s.whereAndWhen).toMatch(/13\.4° North/);
    expect(s.whereAndWhen).toMatch(/144\.8° East/);
    expect(s.whereAndWhen).toMatch(/21 September 2025/);
    expect(s.whereAndWhen).toMatch(/22 September 2025/);
  });

  it('falls back honestly when the investigation carries no AOI ring', () => {
    const s = buildPlainSummary({}, [], null, null, []);
    expect(s.whereAndWhen).toMatch(/recorded in the full technical dossier/);
  });
});

describe('buildPlainSummary — possible origin', () => {
  it('states plainly that nothing could be traced back when there is no origin estimate', () => {
    const s = buildPlainSummary(INV, [], null, null, []);
    expect(s.possibleOrigin).toMatch(/not possible to work out where or when/i);
  });

  it('gives the real release window when the origin estimate is OK', () => {
    const s = buildPlainSummary(
      INV,
      [],
      {
        status: 'OK',
        releaseWindow: {
          mostLikelyStart: '2025-09-20T18:00:00.000Z',
          mostLikelyEnd: '2025-09-20T22:00:00.000Z',
        },
      },
      null,
      [],
    );
    expect(s.possibleOrigin).toMatch(/20 September 2025 at 18:00 UTC/);
    expect(s.possibleOrigin).toMatch(/20 September 2025 at 22:00 UTC/);
  });

  it('flags a degraded estimate as approximate rather than presenting it as precise', () => {
    const s = buildPlainSummary(INV, [], { status: 'DEGRADED' }, null, []);
    expect(s.possibleOrigin).toMatch(/rough estimate/i);
    expect(s.possibleOrigin).toMatch(/approximate/i);
  });
});

describe('buildPlainSummary — vessels', () => {
  it('translates every tier into a complete sentence, never a bare label', () => {
    const s = buildPlainSummary(INV, [detection()], null, null, [
      candidate(1, 'STRONG'),
      candidate(2, 'MODERATE'),
      candidate(3, 'WEAK'),
      candidate(4, 'INSUFFICIENT_EVIDENCE'),
    ]);
    expect(s.vessels).toHaveLength(4);
    for (const v of s.vessels) {
      expect(v.assessment.length).toBeGreaterThan(20);
      expect(v.assessment).not.toMatch(/^(STRONG|MODERATE|WEAK|INSUFFICIENT_EVIDENCE)$/);
    }
    expect(s.vessels[0]!.assessment).toMatch(/strong lead/i);
    expect(s.vessels[2]!.assessment).toMatch(/weak lead/i);
  });

  it("caps the vessel list at five, matching the dossier's own evidence-page limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate(i + 1, 'WEAK'));
    const s = buildPlainSummary(INV, [detection()], null, null, many);
    expect(s.vessels).toHaveLength(5);
  });

  it('carries the real MMSI through untouched, as the one identifier worth keeping literal', () => {
    const s = buildPlainSummary(INV, [detection()], null, null, [
      candidate(1, 'STRONG', 999999999),
    ]);
    expect(s.vessels[0]!.mmsi).toBe(999999999);
  });
});

describe('buildPlainSummary — what this report cannot tell you', () => {
  it('always includes at least the closing caveat, even with a clean OK run', () => {
    const s = buildPlainSummary(
      INV,
      [detection({ lookAlikeCompetition: 0.05 })],
      { status: 'OK', releaseWindow: {} },
      { distinctVessels: 40 } as never,
      [],
    );
    expect(s.whatWeDontKnow.length).toBeGreaterThanOrEqual(1);
    expect(s.whatWeDontKnow.at(-1)).toMatch(/starting point for an investigation/i);
  });

  it('names sparse AIS coverage in plain terms when coverage is thin', () => {
    const s = buildPlainSummary(INV, [], null, { distinctVessels: 2 } as never, []);
    expect(s.whatWeDontKnow.some((t) => /only 2 ships were broadcasting/i.test(t))).toBe(true);
  });

  it('says "No ships" rather than "Only 0 ships" for a truly empty AIS window', () => {
    const s = buildPlainSummary(INV, [], null, { distinctVessels: 0 } as never, []);
    expect(s.whatWeDontKnow.some((t) => /^no ships were broadcasting/i.test(t))).toBe(true);
    expect(s.whatWeDontKnow.some((t) => /only 0/i.test(t))).toBe(false);
  });

  it('does not raise the AIS caveat when coverage is healthy', () => {
    const s = buildPlainSummary(INV, [], null, { distinctVessels: 40 } as never, []);
    expect(s.whatWeDontKnow.some((t) => /broadcasting tracking signals/i.test(t))).toBe(false);
  });

  it('warns about look-alikes only when a detection actually carries that risk', () => {
    const risky = buildPlainSummary(
      INV,
      [detection({ lookAlikeCompetition: 0.6 })],
      null,
      null,
      [],
    );
    expect(risky.whatWeDontKnow.some((t) => /look-alikes/i.test(t))).toBe(true);

    const clean = buildPlainSummary(
      INV,
      [detection({ lookAlikeCompetition: 0.1 })],
      null,
      null,
      [],
    );
    expect(clean.whatWeDontKnow.some((t) => /look-alikes/i.test(t))).toBe(false);
  });

  it('raises the scoring-reliability caveat only when there are candidates to rank', () => {
    const withCandidates = buildPlainSummary(INV, [], null, null, [candidate(1, 'WEAK')]);
    expect(withCandidates.whatWeDontKnow.some((t) => /computed automatically/i.test(t))).toBe(true);

    const withoutCandidates = buildPlainSummary(INV, [], null, null, []);
    expect(withoutCandidates.whatWeDontKnow.some((t) => /computed automatically/i.test(t))).toBe(
      false,
    );
  });

  it('flags a null or degraded origin as an open uncertainty', () => {
    expect(
      buildPlainSummary(INV, [], null, null, []).whatWeDontKnow.some((t) =>
        /where and when the spill was actually released/i.test(t),
      ),
    ).toBe(true);
    expect(
      buildPlainSummary(INV, [], { status: 'DEGRADED' }, null, []).whatWeDontKnow.some((t) =>
        /where and when the spill was actually released/i.test(t),
      ),
    ).toBe(true);
    expect(
      buildPlainSummary(INV, [], { status: 'OK', releaseWindow: {} }, null, []).whatWeDontKnow.some(
        (t) => /where and when the spill was actually released/i.test(t),
      ),
    ).toBe(false);
  });
});

describe('buildPlainSummary — bottom line', () => {
  it('never asserts responsibility or certainty', () => {
    const s = buildPlainSummary(INV, [detection()], null, null, [candidate(1, 'STRONG')]);
    expect(s.bottomLine).toMatch(/not proof/i);
    expect(s.bottomLine.toLowerCase()).not.toContain('responsible for');
  });
});
