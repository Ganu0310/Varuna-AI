import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_FEATURES,
  TIER_THRESHOLDS,
  MIN_MEASURED_FEATURES,
  MAX_AOI_KM2,
  MAX_WINDOW_DAYS,
} from './constants.js';

describe('attribution feature set — 07_AIML §7.6', () => {
  it('has exactly fourteen features', () => {
    expect(ATTRIBUTION_FEATURES).toHaveLength(14);
  });

  it('default weights sum to 1.00', () => {
    const total = ATTRIBUTION_FEATURES.reduce((s, f) => s + f.defaultWeight, 0);
    expect(total).toBeCloseTo(1.0, 10);
  });

  it('spans four evidence families', () => {
    const families = new Set(ATTRIBUTION_FEATURES.map((f) => f.family));
    expect(families).toEqual(new Set(['spatial', 'temporal', 'kinematic', 'behavioural']));
  });

  it('feature keys are unique', () => {
    const keys = ATTRIBUTION_FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('scoring thresholds — 02_TRD §2.8.5', () => {
  it('tiers are strictly ordered', () => {
    expect(TIER_THRESHOLDS.STRONG).toBeGreaterThan(TIER_THRESHOLDS.MODERATE);
    expect(TIER_THRESHOLDS.MODERATE).toBeGreaterThan(TIER_THRESHOLDS.WEAK);
  });

  it('the insufficient-evidence floor is six measured features', () => {
    expect(MIN_MEASURED_FEATURES).toBe(6);
  });
});

describe('investigation bounds — 01_PRD A1', () => {
  it('caps AOI and window', () => {
    expect(MAX_AOI_KM2).toBe(50_000);
    expect(MAX_WINDOW_DAYS).toBe(30);
  });
});
