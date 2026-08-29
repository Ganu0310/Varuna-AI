import { describe, it, expect } from 'vitest';
import { buildSteps, type PipelineState } from './PipelineProgress.tsx';

/**
 * The strip tells an analyst what to do next, so the ordering has to be the pipeline's real
 * ordering. If it ever pointed past a missing precondition — "rank candidates" before an
 * origin exists — it would send someone to a control the server refuses, which is worse than
 * showing nothing.
 */

const empty: PipelineState = {
  scenes: 0,
  detections: 0,
  reviewed: 0,
  hasOrigin: false,
  originDegraded: false,
  candidates: 0,
  aisVessels: 0,
};

const firstIncomplete = (s: PipelineState) => buildSteps(s).find((x) => !x.done)?.key;

describe('pipeline progress', () => {
  it('starts by asking for a scene', () => {
    expect(firstIncomplete(empty)).toBe('scene');
  });

  it('never points past a missing precondition', () => {
    // A fresh investigation with no scene must not be told to rank candidates: correlation
    // is refused with a 409 until an origin exists, and an origin needs a detection.
    const steps = buildSteps(empty);
    const order = steps.map((s) => s.key);
    expect(order.indexOf('scene')).toBeLessThan(order.indexOf('detect'));
    expect(order.indexOf('detect')).toBeLessThan(order.indexOf('origin'));
    expect(order.indexOf('origin')).toBeLessThan(order.indexOf('correlate'));
  });

  it('advances as each stage completes', () => {
    const withScene = { ...empty, scenes: 1 };
    expect(firstIncomplete(withScene)).toBe('detect');

    const withDetections = { ...withScene, detections: 13 };
    expect(firstIncomplete(withDetections)).toBe('ais');

    const withAis = { ...withDetections, aisVessels: 27 };
    expect(firstIncomplete(withAis)).toBe('origin');

    const withOrigin = { ...withAis, hasOrigin: true };
    expect(firstIncomplete(withOrigin)).toBe('correlate');

    const done = { ...withOrigin, candidates: 27 };
    expect(firstIncomplete(done)).toBeUndefined();
  });

  it('reports a degraded origin as degraded, not merely as done', () => {
    // Marking it complete without saying how would hide the single fact that caps every
    // candidate at MODERATE.
    const s = buildSteps({ ...empty, hasOrigin: true, originDegraded: true });
    const origin = s.find((x) => x.key === 'origin')!;
    expect(origin.done).toBe(true);
    expect(origin.detail).toMatch(/DEGRADED/);
  });

  it('flags absent AIS as a blocker rather than a step to perform', () => {
    // AIS is a fact about the area, not an action. With none, the chain can run to the end
    // and still produce nothing, and the reason should be visible before that happens.
    const ais = buildSteps(empty).find((x) => x.key === 'ais')!;
    expect(ais.done).toBe(false);
    expect(ais.detail).toMatch(/no AIS/i);
    expect(ais.next).toMatch(/nobody to attribute/i);
  });

  it('counts reviewed detections separately from found ones', () => {
    const s = buildSteps({ ...empty, scenes: 1, detections: 13, reviewed: 2 });
    expect(s.find((x) => x.key === 'detect')!.detail).toBe('13 found, 2 reviewed');
  });
});
