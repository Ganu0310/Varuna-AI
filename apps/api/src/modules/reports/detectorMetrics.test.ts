import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The failure direction that matters.
 *
 * This module lets the dossier replace "the detector has no measured oil-IoU or
 * false-positive rate" with real figures. The dangerous failure is not a crash — it is a
 * missing or malformed metrics file causing the report to imply the detector was validated
 * when it was not. Every failure path must fall back to the ADMISSION, never to silence and
 * never to an optimistic default.
 */

type FsModule = typeof import('node:fs');

const files = new Map<string, string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<FsModule>();
  return {
    ...actual,
    existsSync: (p: string) => files.has(String(p)),
    readFileSync: (p: string, enc?: unknown) => {
      const key = String(p);
      if (files.has(key)) return files.get(key)!;
      return actual.readFileSync(p as never, enc as never);
    },
  };
});

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('../../lib/logger.js', () => ({ logger }));

const VALID = {
  datasetId: 'trujillo-acatitla-s1-oil-spill-part3-test',
  citation: 'Trujillo-Acatitla, R. et al. (2024). Sentinel-1 SAR Oil spill image dataset...',
  licence: 'CC-BY-4.0',
  measuredAt: '2026-08-29T00:00:00Z',
  detectorVersion: 'darkspot-v1',
  scenes: { oil: 150, lookalike: 150, noOil: 150 },
  oil: { meanIou: 0.31, medianIou: 0.22, detectionRate: 0.86, missedEntirely: 21 },
  falsePositives: {
    lookalikeSceneRate: 0.34,
    noOilSceneRate: 0.08,
    lookalikeMeanRiskFlagged: 0.41,
  },
};

async function load(fileContent?: string) {
  vi.resetModules();
  files.clear();
  const mod = await import('./detectorMetrics.js');
  mod.resetDetectorMetricsCache();
  if (fileContent !== undefined) {
    // Resolve the same path the module computes, so the mock intercepts the real lookup.
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    files.set(resolve(here, '../../../../../data/eval/detector-partIII-summary.json'), fileContent);
  }
  mod.resetDetectorMetricsCache();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  files.clear();
});

describe('detector metrics — absent or unusable', () => {
  it('states the detector is UNMEASURED when no metrics file exists', async () => {
    const { detectorMetrics, detectorLimitationText } = await load();

    expect(detectorMetrics()).toBeNull();
    expect(detectorLimitationText()).toMatch(/no measured oil-IoU or false-positive rate/i);
  });

  it('falls back to the admission when the file is malformed, and says so loudly', async () => {
    const { detectorMetrics, detectorLimitationText } = await load('{ not json');

    expect(detectorMetrics()).toBeNull();
    expect(detectorLimitationText()).toMatch(/no measured oil-IoU/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects a file missing the false-positive rates rather than reporting a partial result', async () => {
    // A metrics file with IoU but no false-positive rate would let the report advertise
    // accuracy while omitting the number that qualifies it.
    const partial = { ...VALID } as Record<string, unknown>;
    delete partial.falsePositives;

    const { detectorMetrics, detectorLimitationText } = await load(JSON.stringify(partial));

    expect(detectorMetrics()).toBeNull();
    expect(detectorLimitationText()).toMatch(/no measured oil-IoU/i);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('detector metrics — present and valid', () => {
  it('reports IoU, detection rate and BOTH false-positive rates', async () => {
    const { detectorLimitationText } = await load(JSON.stringify(VALID));
    const text = detectorLimitationText();

    expect(text).toContain('0.31'); // mean IoU
    expect(text).toContain('86%'); // detection rate
    expect(text).toContain('34%'); // look-alike FP rate
    expect(text).toContain('8%'); // oil-free FP rate
    expect(text).toContain('450'); // total held-out scenes
    expect(text).toMatch(/CC-BY-4\.0/);
  });

  it('never drops the qualitative limitation just because numbers exist', async () => {
    // Measuring a weakness does not remove it. The sentence about being unable to separate
    // oil from look-alikes by texture must survive, or the report reads as a clean bill of
    // health with some statistics attached.
    const { detectorLimitationText } = await load(JSON.stringify(VALID));
    const text = detectorLimitationText();

    expect(text).toMatch(/cannot classify oil versus look-alike from texture/i);
    expect(text).toMatch(/not a trained segmentation model/i);
    expect(text).toMatch(/lead to verify, not as evidence/i);
  });

  it('states the scenes were never fitted to, which is what makes them held out', async () => {
    const { detectorLimitationText } = await load(JSON.stringify(VALID));
    expect(detectorLimitationText()).toMatch(/never been fitted to/i);
  });

  it('warns when the risk score FAILED to flag its own false positives', async () => {
    // The measured value is 0.26: on scenes where the detector was provably wrong it still
    // reported low look-alike risk. That is the warning channel pointing the wrong way, and
    // it is more actionable than the raw error rate.
    const { detectorLimitationText } = await load(JSON.stringify(VALID));
    const text = detectorLimitationText();

    expect(text).toMatch(/not merely wrong but unwarned/i);
    expect(text).toMatch(/do not read a low look-alike risk as evidence/i);
  });

  it('omits that warning when the risk score DID flag them', async () => {
    // A detector that fires wrongly but marks the result high-risk has behaved acceptably;
    // asserting the caveat unconditionally would make it meaningless.
    const good = {
      ...VALID,
      falsePositives: { ...VALID.falsePositives, lookalikeMeanRiskFlagged: 0.82 },
    };
    const { detectorLimitationText } = await load(JSON.stringify(good));
    const text = detectorLimitationText();

    expect(text).not.toMatch(/unwarned/i);
    expect(text).toMatch(/34%/); // the rate is still reported
  });
});
