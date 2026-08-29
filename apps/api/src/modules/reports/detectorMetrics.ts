import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

/**
 * Measured detector performance on a real held-out test split — 14 §14.6 Phase 13.
 *
 * The dossier's detector caveat used to say the detector "has no measured oil-IoU or
 * false-positive rate on a held-out test split", which was true. This module lets it state
 * the real figures instead — but ONLY when a measurement file is actually present.
 *
 * The fallback is the honest admission, not an optimistic default. A missing or malformed
 * file must never let the report imply the detector was validated when it was not, so every
 * failure path here returns `null` and the caller keeps the original wording.
 */

const Summary = z
  .object({
    datasetId: z.string().min(1),
    citation: z.string().min(1),
    licence: z.string().min(1),
    measuredAt: z.string().min(1),
    detectorVersion: z.string().min(1),
    scenes: z.object({ oil: z.number(), lookalike: z.number(), noOil: z.number() }),
    oil: z.object({
      meanIou: z.number(),
      medianIou: z.number(),
      detectionRate: z.number(),
      missedEntirely: z.number(),
    }),
    falsePositives: z.object({
      lookalikeSceneRate: z.number(),
      noOilSceneRate: z.number(),
      lookalikeMeanRiskFlagged: z.number().nullable(),
    }),
  })
  .strict();

export type DetectorMetrics = z.infer<typeof Summary>;

const HERE = dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = resolve(HERE, '../../../../../data/eval/detector-partIII-summary.json');

let cached: DetectorMetrics | null | undefined;

export function detectorMetrics(): DetectorMetrics | null {
  if (cached !== undefined) return cached;

  try {
    if (!existsSync(METRICS_PATH)) {
      cached = null;
      return cached;
    }
    const parsed = Summary.safeParse(JSON.parse(readFileSync(METRICS_PATH, 'utf8')));
    if (!parsed.success) {
      // Loud, because a malformed metrics file means the report silently reverts to saying
      // the detector is unvalidated — which is safe, but should not happen unnoticed.
      logger.error(
        { path: METRICS_PATH, issues: parsed.error.issues },
        'detector metrics file is malformed; the report will state the detector is unmeasured',
      );
      cached = null;
      return cached;
    }
    cached = parsed.data;
  } catch (err) {
    logger.error({ err, path: METRICS_PATH }, 'could not read detector metrics');
    cached = null;
  }
  return cached;
}

/**
 * The Detector limitation paragraph.
 *
 * Measured or not, this stays a LIMITATION rather than becoming a reassurance. Knowing the
 * false-positive rate does not remove it — it quantifies it, and the number is the point:
 * an analyst reading a detection needs to know how often this algorithm fires on water that
 * merely looks oily.
 */
export function detectorLimitationText(): string {
  const m = detectorMetrics();

  const preamble =
    'Detection used a classical adaptive-threshold algorithm, not a trained segmentation ' +
    'model. It locates dark features and scores how oil-like their shape and context are; it ' +
    'cannot classify oil versus look-alike from texture';

  if (!m) {
    return (
      `${preamble}, and has no measured oil-IoU or false-positive rate on a held-out test ` +
      'split.'
    );
  }

  const pct = (v: number) => `${(100 * v).toFixed(0)}%`;
  const total = m.scenes.oil + m.scenes.lookalike + m.scenes.noOil;

  // The risk score is the detector's own warning channel: a high value tells the analyst
  // "this may not be oil". If it stays LOW on scenes where the detector is provably wrong,
  // the warning is not merely weak — it points the wrong way, and saying so is the single
  // most useful sentence in this paragraph.
  const risk = m.falsePositives.lookalikeMeanRiskFlagged;
  const riskSentence =
    risk !== null && risk < 0.5
      ? ` On those look-alike scenes it assigned a mean look-alike risk of only ${risk.toFixed(2)}, ` +
        'so it was not merely wrong but unwarned: its own risk score did not flag the very ' +
        'cases it exists to flag. Do not read a low look-alike risk as evidence that a ' +
        'detection is oil.'
      : '';

  return (
    `${preamble}. Measured on ${total} held-out real Sentinel-1 scenes it has never been ` +
    `fitted to (${m.citation.split('(')[0]?.trim() ?? m.datasetId}, ${m.licence}): mean ` +
    `oil-region IoU ${m.oil.meanIou.toFixed(2)} (median ${m.oil.medianIou.toFixed(2)}), ` +
    `overlapping the true slick in ${pct(m.oil.detectionRate)} of ${m.scenes.oil} oil scenes ` +
    `and missing ${m.oil.missedEntirely} entirely. It reported at least one detection on ` +
    `${pct(m.falsePositives.lookalikeSceneRate)} of ${m.scenes.lookalike} look-alike scenes ` +
    `and ${pct(m.falsePositives.noOilSceneRate)} of ${m.scenes.noOil} oil-free scenes, where ` +
    `the correct answer was nothing at all.${riskSentence} Treat a single detection as a ` +
    'lead to verify, not as evidence of oil.'
  );
}

/** Test seam — the module caches, and a test that changes the file needs to invalidate it. */
export function resetDetectorMetricsCache(): void {
  cached = undefined;
}
