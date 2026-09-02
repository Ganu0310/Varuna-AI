import { describe, it, expect } from 'vitest';
import { evaluateAutoReview, type AutoReviewInput } from './autoReview.js';

/**
 * Deep test suite for the Automated Review Engine.
 *
 * Tests the three-way classification (AUTO_CONFIRMED / AUTO_REJECTED / UNREVIEWED)
 * across all threshold boundaries, edge cases, and the autoTriggerPipeline flag.
 *
 * The thresholds being tested:
 *   AUTO_CONFIRMED: confidence >= 0.75 AND lookAlikeRisk < 0.20 AND areaKm2 >= 0.10
 *   AUTO_REJECTED:  lookAlikeRisk >= 0.60 OR (confidence < 0.35 AND lookAlikeRisk >= 0.40)
 *   UNREVIEWED:     everything else
 */

// ── AUTO_CONFIRMED: all three gates must pass ─────────────────────────

describe('AUTO_CONFIRMED — all three gates must pass simultaneously', () => {
  it('classic high-confidence slick', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.85, lookAlikeRisk: 0.1, areaKm2: 0.5 });
    expect(r.status).toBe('AUTO_CONFIRMED');
    expect(r.autoTriggerPipeline).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('exactly at the confidence threshold (0.75)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.75, lookAlikeRisk: 0.19, areaKm2: 0.1 });
    expect(r.status).toBe('AUTO_CONFIRMED');
    expect(r.autoTriggerPipeline).toBe(true);
  });

  it('exactly at the area threshold (0.10 km²)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.05, areaKm2: 0.1 });
    expect(r.status).toBe('AUTO_CONFIRMED');
  });

  it('lookAlikeRisk at 0.19 (just under 0.20 gate) still confirms', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.9, lookAlikeRisk: 0.19, areaKm2: 1.0 });
    expect(r.status).toBe('AUTO_CONFIRMED');
  });

  it('perfect detection (1.0 confidence, 0 risk, large area)', () => {
    const r = evaluateAutoReview({ overallConfidence: 1.0, lookAlikeRisk: 0.0, areaKm2: 100 });
    expect(r.status).toBe('AUTO_CONFIRMED');
    expect(r.autoTriggerPipeline).toBe(true);
  });

  // ── fails when any single gate is not met ────────────────────────

  it('fails confirm when confidence is 0.74 (just below threshold)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.74, lookAlikeRisk: 0.1, areaKm2: 0.5 });
    expect(r.status).not.toBe('AUTO_CONFIRMED');
  });

  it('fails confirm when lookAlikeRisk is exactly 0.20 (not strictly less)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.2, areaKm2: 0.5 });
    expect(r.status).not.toBe('AUTO_CONFIRMED');
  });

  it('fails confirm when area is 0.09 km² (below 0.10 threshold)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.1, areaKm2: 0.09 });
    expect(r.status).not.toBe('AUTO_CONFIRMED');
  });
});

// ── AUTO_REJECTED: either path triggers rejection ─────────────────────

describe('AUTO_REJECTED — two independent trigger paths', () => {
  it('rejects on high lookAlikeRisk alone (>= 0.60)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.9, lookAlikeRisk: 0.6, areaKm2: 5.0 });
    expect(r.status).toBe('AUTO_REJECTED');
    expect(r.autoTriggerPipeline).toBe(false);
  });

  it('rejects on extreme lookAlikeRisk (1.0)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.95, lookAlikeRisk: 1.0, areaKm2: 10.0 });
    expect(r.status).toBe('AUTO_REJECTED');
  });

  it('rejects on combined low-confidence + moderate lookAlikeRisk (< 0.35 && >= 0.40)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.34, lookAlikeRisk: 0.4, areaKm2: 0.5 });
    expect(r.status).toBe('AUTO_REJECTED');
    expect(r.autoTriggerPipeline).toBe(false);
  });

  it('rejects at exact boundary of combined path (0.34 confidence, 0.40 risk)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.34, lookAlikeRisk: 0.4, areaKm2: 0.2 });
    expect(r.status).toBe('AUTO_REJECTED');
  });

  it('does NOT reject when confidence is exactly 0.35 and risk is 0.40 (combined path requires < 0.35)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.35, lookAlikeRisk: 0.4, areaKm2: 0.2 });
    expect(r.status).not.toBe('AUTO_REJECTED');
  });

  it('does NOT reject when lookAlikeRisk is 0.59 (just under 0.60 standalone threshold)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.5, lookAlikeRisk: 0.59, areaKm2: 0.5 });
    expect(r.status).not.toBe('AUTO_REJECTED');
  });
});

// ── UNREVIEWED: the manual-review fallback ────────────────────────────

describe('UNREVIEWED — borderline detections remain for analyst manual review', () => {
  it('mid-confidence, mid-risk is UNREVIEWED', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.6, lookAlikeRisk: 0.3, areaKm2: 0.2 });
    expect(r.status).toBe('UNREVIEWED');
    expect(r.autoTriggerPipeline).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('high confidence but lookAlikeRisk at 0.20 (fails confirm gate) goes to UNREVIEWED', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.2, areaKm2: 0.5 });
    expect(r.status).toBe('UNREVIEWED');
  });

  it('high confidence but area too small (fails area gate) goes to UNREVIEWED', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.1, areaKm2: 0.05 });
    expect(r.status).toBe('UNREVIEWED');
  });

  it('confidence in the 0.35-0.75 band with low risk stays UNREVIEWED', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.5, lookAlikeRisk: 0.15, areaKm2: 0.2 });
    expect(r.status).toBe('UNREVIEWED');
  });

  it('confidence at 0.35 with risk at 0.39 stays UNREVIEWED (below combined reject path)', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.35, lookAlikeRisk: 0.39, areaKm2: 0.5 });
    expect(r.status).toBe('UNREVIEWED');
  });
});

// ── reasons array quality ─────────────────────────────────────────────

describe('reasons array quality', () => {
  it('AUTO_CONFIRMED reasons mention the actual values', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.85, lookAlikeRisk: 0.1, areaKm2: 0.5 });
    expect(r.reasons[0]).toMatch(/0\.85/);
    expect(r.reasons[0]).toMatch(/0\.10/);
    expect(r.reasons[0]).toMatch(/0\.50/);
  });

  it('AUTO_REJECTED reasons describe the risk', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.6, lookAlikeRisk: 0.65, areaKm2: 0.5 });
    expect(r.reasons[0]).toMatch(/risk/i);
  });

  it('UNREVIEWED reasons mention ambiguity', () => {
    const r = evaluateAutoReview({ overallConfidence: 0.5, lookAlikeRisk: 0.3, areaKm2: 0.2 });
    expect(r.reasons[0]).toMatch(/ambiguous/i);
  });

  it('every assessment produces exactly one reason', () => {
    const inputs: AutoReviewInput[] = [
      { overallConfidence: 0.85, lookAlikeRisk: 0.1, areaKm2: 0.5 },
      { overallConfidence: 0.6, lookAlikeRisk: 0.65, areaKm2: 0.5 },
      { overallConfidence: 0.5, lookAlikeRisk: 0.3, areaKm2: 0.2 },
    ];
    for (const input of inputs) {
      const r = evaluateAutoReview(input);
      expect(r.reasons).toHaveLength(1);
    }
  });
});

// ── autoTriggerPipeline contract ──────────────────────────────────────

describe('autoTriggerPipeline is true ONLY for AUTO_CONFIRMED', () => {
  const cases: Array<{ input: AutoReviewInput; expectedStatus: string; expectedTrigger: boolean }> =
    [
      {
        input: { overallConfidence: 0.85, lookAlikeRisk: 0.1, areaKm2: 0.5 },
        expectedStatus: 'AUTO_CONFIRMED',
        expectedTrigger: true,
      },
      {
        input: { overallConfidence: 0.6, lookAlikeRisk: 0.65, areaKm2: 0.5 },
        expectedStatus: 'AUTO_REJECTED',
        expectedTrigger: false,
      },
      {
        input: { overallConfidence: 0.3, lookAlikeRisk: 0.45, areaKm2: 0.2 },
        expectedStatus: 'AUTO_REJECTED',
        expectedTrigger: false,
      },
      {
        input: { overallConfidence: 0.5, lookAlikeRisk: 0.3, areaKm2: 0.2 },
        expectedStatus: 'UNREVIEWED',
        expectedTrigger: false,
      },
    ];

  for (const { input, expectedStatus, expectedTrigger } of cases) {
    it(`confidence=${input.overallConfidence} risk=${input.lookAlikeRisk} => ${expectedStatus}, trigger=${expectedTrigger}`, () => {
      const r = evaluateAutoReview(input);
      expect(r.status).toBe(expectedStatus);
      expect(r.autoTriggerPipeline).toBe(expectedTrigger);
    });
  }
});

// ── priority ordering: confirm is checked BEFORE reject ───────────────

describe('evaluation priority: confirm gate is checked before reject gate', () => {
  it('a detection that passes confirm thresholds is confirmed even if risk is exactly 0.19', () => {
    // 0.19 is below both the reject threshold (0.60) and the confirm gate (< 0.20).
    const r = evaluateAutoReview({ overallConfidence: 0.8, lookAlikeRisk: 0.19, areaKm2: 1.0 });
    expect(r.status).toBe('AUTO_CONFIRMED');
  });
});
