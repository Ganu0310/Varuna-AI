import { Types } from 'mongoose';
import {
  REJECTION_CATEGORIES,
  trainingClassFor,
  type RejectionCategory,
  type SarClass,
} from '@varuna/shared';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from './model.js';

/**
 * The labelled set that analyst review has already produced — 07_AIML §7.2.12.
 *
 * Every review action is a human judgement about real SAR pixels, and until now every one
 * of them was thrown away the moment it was recorded. That is the expensive half of a
 * training set — the imagery is free, the labelling is not — and this system generates it
 * as a by-product of ordinary work.
 *
 * It matters because of a specific measured failure. On 66 held-out real scenes the shipped
 * detector overlapped the true slick in 100% of oil scenes but fired on 68% of look-alike
 * scenes, and on those false positives its own look-alike warning averaged 0.26. It is not
 * merely wrong; it is wrong without warning. The fix is not a threshold — it is labelled
 * negatives of each look-alike class, which is exactly what a rejection with a category is.
 *
 * Three rules govern what comes out of here, and each exists to stop a plausible-looking
 * but dishonest label:
 *
 *  1. **An UNREVIEWED detection is not a label.** No human looked at it. Excluded.
 *  2. **An OPERATIONAL rejection is not a negative.** "Duplicate" and "out of scope" are
 *     statements about the workflow, not about the imagery. Training on them would teach
 *     the detector that a perfectly good slick is not a slick.
 *  3. **A rejection recorded before the taxonomy existed is UNCATEGORISED, not guessed.**
 *     It is counted, reported, and left out of the training set.
 *
 * Nothing here trains anything. It assembles and counts, so the decision to retrain is made
 * against a number somebody can see.
 */

/**
 * A working target, not a measured one.
 *
 * The held-out evaluation split carries 22 scenes per class, so a training set materially
 * smaller than that cannot be said to have taught the model a class it will be tested on.
 * 25 is that figure with a little headroom. It is a judgement call and is labelled as one
 * wherever it is reported — it must never be read as a validated sample-size result.
 */
export const MIN_LABELS_PER_CLASS = 25;

export type LabelPolarity = 'POSITIVE' | 'NEGATIVE';

export interface TrainingLabel {
  detectionId: string;
  investigationId: string;
  sceneId: string;
  /** The provider product id, so the pixels behind this label can be fetched again. */
  productId: string | null;
  acquiredAt: string | null;
  geometry: unknown;
  /** Whether `geometry` is the detector's own outline or an analyst's correction. */
  geometrySource: 'MODEL' | 'ANALYST';
  areaKm2: number;
  polarity: LabelPolarity;
  sarClass: SarClass;
  rejectionCategory: RejectionCategory | null;
  reviewStatus: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  note: string | null;
  detector: { name: string | null; version: string | null; artefactSha256: string | null };
  /**
   * What the detector's own warning channel said about a sample a human then rejected.
   * The gap between this and the truth is the number a retrain has to close.
   */
  lookAlikeRisk: number | null;
  provenance: unknown;
}

export interface UnusableLabel {
  detectionId: string;
  reviewStatus: string;
  rejectionCategory: RejectionCategory | null;
  reason: string;
}

/** One reviewed detection, flattened out of Mongo, before it is judged usable or not. */
export interface ReviewedDetection {
  detectionId: string;
  investigationId: string;
  sceneId: string;
  productId: string | null;
  acquiredAt: string | null;
  geometry: unknown;
  areaKm2: number;
  reviewStatus: string;
  edited: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  note: string | null;
  rejectionCategory: RejectionCategory | null;
  detector: { name: string | null; version: string | null; artefactSha256: string | null };
  lookAlikeRisk: number | null;
  provenance: unknown;
}

export interface LabelSummary {
  reviewedDetections: number;
  usable: number;
  byClass: Record<string, number>;
  byCategory: Record<string, number>;
  unusable: { count: number; byReason: Record<string, number> };
  /** Classes that have appeared but are still short of MIN_LABELS_PER_CLASS. */
  shortfall: Array<{ sarClass: string; held: number; needed: number }>;
  readyToRetrain: boolean;
  assessment: string;
}

const CATEGORY_BY_ID = new Map(REJECTION_CATEGORIES.map((c) => [c.id as string, c]));

type LabelCore = Omit<TrainingLabel, 'polarity' | 'sarClass' | 'rejectionCategory'>;

function labelFields(d: ReviewedDetection): LabelCore {
  return {
    detectionId: d.detectionId,
    investigationId: d.investigationId,
    sceneId: d.sceneId,
    productId: d.productId,
    acquiredAt: d.acquiredAt,
    geometry: d.geometry,
    // An EDIT replaced the outline, so the geometry a trainer would rasterise is the
    // analyst's, not the model's. Saying which is not a detail: training a segmenter on a
    // human-corrected mask while calling it the detector's own output would corrupt the
    // very comparison the retrain exists to win.
    geometrySource: d.edited ? 'ANALYST' : 'MODEL',
    areaKm2: d.areaKm2,
    reviewStatus: d.reviewStatus,
    reviewedAt: d.reviewedAt,
    reviewedBy: d.reviewedBy,
    note: d.note,
    detector: d.detector,
    lookAlikeRisk: d.lookAlikeRisk,
    provenance: d.provenance,
  };
}

/**
 * Decide, for one reviewed detection, whether it is a usable label — and if not, why not.
 *
 * Pure, so the rule that governs what may be trained on is testable without a database.
 */
export function classify(d: ReviewedDetection): TrainingLabel | UnusableLabel {
  const base = {
    detectionId: d.detectionId,
    reviewStatus: d.reviewStatus,
    rejectionCategory: d.rejectionCategory,
  };

  if (d.reviewStatus === 'CONFIRMED' || d.reviewStatus === 'EDITED') {
    return {
      ...labelFields(d),
      polarity: 'POSITIVE',
      sarClass: 'oil_spill',
      rejectionCategory: null,
    };
  }

  if (d.reviewStatus !== 'REJECTED') {
    return { ...base, reason: `Review status ${d.reviewStatus} carries no human judgement.` };
  }

  if (!d.rejectionCategory) {
    return {
      ...base,
      reason:
        'Rejected without a category — recorded before the taxonomy existed. Counted, and ' +
        'not back-filled with a guess.',
    };
  }

  const category = CATEGORY_BY_ID.get(d.rejectionCategory);
  const sarClass = trainingClassFor(d.rejectionCategory);

  if (!sarClass) {
    return {
      ...base,
      reason:
        category?.kind === 'OPERATIONAL'
          ? `${d.rejectionCategory} is an operational rejection — it says nothing about the ` +
            'imagery, so it is not a negative.'
          : `${d.rejectionCategory} is not a valid sample of any physical class.`,
    };
  }

  return {
    ...labelFields(d),
    polarity: 'NEGATIVE',
    sarClass,
    rejectionCategory: d.rejectionCategory,
  };
}

function isUsable(x: TrainingLabel | UnusableLabel): x is TrainingLabel {
  return 'polarity' in x;
}

/** Aggregate the classified set. Pure — see `classify`. */
export function summarise(classified: Array<TrainingLabel | UnusableLabel>): LabelSummary {
  const usable = classified.filter(isUsable);
  const unusable = classified.filter((x) => !isUsable(x)) as UnusableLabel[];

  const byClass: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const l of usable) {
    byClass[l.sarClass] = (byClass[l.sarClass] ?? 0) + 1;
    const key = l.rejectionCategory ?? 'CONFIRMED_OIL';
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }

  const byReason: Record<string, number> = {};
  for (const u of unusable) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;

  // Only classes that have actually appeared are reported as short. Listing every member of
  // SAR_CLASSES at zero would imply we are collecting toward all of them, which we are not:
  // the classes an analyst produces are the ones the detector actually gets wrong, and that
  // distribution is itself the finding.
  const shortfall = Object.entries(byClass)
    .filter(([, n]) => n < MIN_LABELS_PER_CLASS)
    .map(([sarClass, held]) => ({ sarClass, held, needed: MIN_LABELS_PER_CLASS - held }))
    .sort((a, b) => b.needed - a.needed);

  const readyToRetrain =
    usable.length > 0 && shortfall.length === 0 && Object.keys(byClass).length >= 2;

  return {
    reviewedDetections: classified.length,
    usable: usable.length,
    byClass,
    byCategory,
    unusable: { count: unusable.length, byReason },
    shortfall,
    readyToRetrain,
    assessment: assess(usable.length, byClass, shortfall, readyToRetrain),
  };
}

function assess(
  usable: number,
  byClass: Record<string, number>,
  shortfall: LabelSummary['shortfall'],
  ready: boolean,
): string {
  if (usable === 0) {
    return (
      'No usable labels yet. Every confirmed detection is a positive and every categorised ' +
      'look-alike rejection is a negative, so this fills as analysts work — nothing has to ' +
      'be collected separately.'
    );
  }
  if (ready) {
    return (
      `${usable} labels across ${Object.keys(byClass).length} classes, each at or above the ` +
      `${MIN_LABELS_PER_CLASS}-sample working target. Enough to attempt a retrain. That ` +
      'target is a judgement call, not a measured sample-size result, and a retrained model ' +
      'still has to beat the shipped one on the held-out split before it ships.'
    );
  }
  const worst = shortfall[0];
  return (
    `${usable} usable label(s) held; not yet enough to retrain. ` +
    (worst
      ? `Shortest class is ${worst.sarClass} at ${worst.held} against a ` +
        `${MIN_LABELS_PER_CLASS}-sample working target (${worst.needed} more needed). `
      : '') +
    'Counts below the target are reported rather than hidden, because a model trained on a ' +
    'handful of examples per class would be worse than the classical detector without being ' +
    'visibly so.'
  );
}

export interface LabelQuery {
  investigationId?: string;
  limit?: number;
}

/**
 * Assemble the labelled set from every reviewed detection, newest first.
 *
 * Scenes are resolved in one grouped query rather than per detection: the product id is
 * what makes a label re-fetchable, and paying a round trip per row for it would make the
 * export unusable at the size it is meant to reach.
 */
export async function detectionLabels(q: LabelQuery = {}): Promise<{
  items: TrainingLabel[];
  unusable: UnusableLabel[];
  summary: LabelSummary;
}> {
  const filter: Record<string, unknown> = {
    reviewStatus: { $in: ['CONFIRMED', 'EDITED', 'REJECTED'] },
  };
  if (q.investigationId) filter.investigationId = new Types.ObjectId(q.investigationId);

  const docs = await SpillDetectionModel.find(filter)
    .sort({ _id: -1 })
    .limit(Math.min(q.limit ?? 2000, 10_000))
    .lean();

  const sceneIds = [...new Set(docs.map((d) => String(d.sceneId)).filter(Boolean))];
  const scenes = await SatelliteSceneModel.find(
    { _id: { $in: sceneIds.map((s) => new Types.ObjectId(s)) } },
    { productId: 1, acquiredAt: 1 },
  ).lean();
  const sceneById = new Map(scenes.map((s) => [String(s._id), s]));

  const reviewed: ReviewedDetection[] = docs.map((d) => {
    const history = (d.reviewHistory ?? []) as Array<{
      userId?: unknown;
      action: string;
      at?: Date;
      note?: string;
      rejectionCategory?: string;
    }>;
    const last = history[history.length - 1];
    // The category belongs to the REJECT that produced the CURRENT status, which is not
    // necessarily the last entry — a REJECT, REOPEN, REJECT leaves two of them.
    const lastReject = [...history].reverse().find((h) => h.action === 'REJECT');
    const scene = sceneById.get(String(d.sceneId));

    return {
      detectionId: String(d._id),
      investigationId: String(d.investigationId),
      sceneId: String(d.sceneId),
      productId: scene?.productId ?? null,
      acquiredAt: scene?.acquiredAt ? new Date(scene.acquiredAt).toISOString() : null,
      geometry: d.geometry,
      areaKm2: d.areaKm2,
      reviewStatus: String(d.reviewStatus),
      edited: history.some((h) => h.action === 'EDIT'),
      reviewedAt: last?.at ? new Date(last.at).toISOString() : null,
      reviewedBy: last?.userId ? String(last.userId) : null,
      note: lastReject?.note ?? last?.note ?? null,
      rejectionCategory: (lastReject?.rejectionCategory as RejectionCategory | undefined) ?? null,
      detector: {
        name: d.model?.name ?? null,
        version: d.model?.version ?? null,
        artefactSha256: d.model?.artefactSha256 ?? null,
      },
      lookAlikeRisk: d.confidence?.lookAlikeCompetition ?? null,
      provenance: (d as { provenance?: unknown }).provenance,
    };
  });

  const classified = reviewed.map(classify);
  return {
    items: classified.filter(isUsable),
    unusable: classified.filter((x) => !isUsable(x)) as UnusableLabel[],
    summary: summarise(classified),
  };
}
