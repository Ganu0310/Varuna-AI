import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { REJECTION_CATEGORIES, trainingClassFor, type RejectionCategory } from '@varuna/shared';
import { NotFoundError, HttpError } from '../../errors.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import { audit } from '../audit/service.js';
import { SpillDetectionModel } from './model.js';

/**
 * Detection review — 06_BACKEND §6.4.5, 08_APP_FLOW §8.2.
 *
 * The governing rule: **the model's output is immutable.** An analyst can confirm, reject
 * or correct a detection, but none of those actions overwrite what the detector produced.
 * An edit creates a NEW VERSION; the original geometry stays retrievable through
 * `/versions` forever.
 *
 * That is not bureaucracy. This system's output can be used to accuse a vessel operator, so
 * "what did the algorithm actually say, before a human adjusted it?" must remain answerable
 * months later — including to someone challenging the finding. If review overwrote the
 * model output, an edited detection would be indistinguishable from an original one.
 */

export type ReviewAction = 'CONFIRM' | 'REJECT' | 'EDIT' | 'REOPEN';

export interface ReviewInput {
  detectionId: string;
  action: ReviewAction;
  actorId: string;
  note?: string;
  /** Required for REJECT: which of REJECTION_CATEGORIES this was. */
  rejectionCategory?: RejectionCategory;
  /** Required for EDIT: the corrected outline. */
  geometry?: Polygon;
  requestId?: string;
}

export interface ReviewResult {
  detectionId: string;
  reviewStatus: string;
  version: number;
  areaKm2: number;
  geometryChanged: boolean;
  rejectionCategory?: RejectionCategory;
  /**
   * The SAR class this rejection contributes as a labelled negative, or null when it
   * contributes none. Returned so the analyst who made the call is told, at the moment
   * they make it, whether it fed the detector or only the case file.
   */
  trainingClass?: string | null;
}

const STATUS_FOR: Record<ReviewAction, string> = {
  CONFIRM: 'CONFIRMED',
  REJECT: 'REJECTED',
  EDIT: 'EDITED',
  REOPEN: 'UNREVIEWED',
};

export async function reviewDetection(input: ReviewInput): Promise<ReviewResult> {
  const doc = await SpillDetectionModel.findById(input.detectionId);
  if (!doc) throw new NotFoundError('Detection not found');

  // A rejection without a reason is not reviewable by anyone else later, so it is refused
  // rather than recorded as an unexplained deletion (06_BACKEND §6.4.5).
  if (input.action === 'REJECT' && !input.note?.trim()) {
    throw new HttpError(
      422,
      'A reason is required to reject a detection',
      'Rejecting removes a detection from the analysis. State why, so the decision can be ' +
        'reviewed later.',
      'https://varuna.dev/problems/review-reason-required',
    );
  }

  /*
   * And a rejection without a CATEGORY is refused for a second, different reason.
   *
   * The note explains the decision to a human reading this one case. The category is the
   * same decision in a form that aggregates: it is what lets us say "the detector fell for
   * eleven low-wind zones and two rain cells", and it is what turns an analyst's judgement
   * into a labelled negative the detector can be retrained against. Free text does neither.
   *
   * The detector's measured failure is 68% false positives on look-alike scenes with its
   * own warning channel reading 0.26 — wrong and unwarned. Labelled negatives of each
   * physical class are the fix, and every rejection is one that is otherwise thrown away.
   */
  if (input.action === 'REJECT' && !input.rejectionCategory) {
    throw new HttpError(
      422,
      'A category is required to reject a detection',
      'Name what this actually was. The note explains the decision; the category is what ' +
        'makes it countable across cases and usable as a labelled negative for the ' +
        'detector. Categories: ' +
        REJECTION_CATEGORIES.map((c) => c.id).join(', ') +
        '.',
      'https://varuna.dev/problems/review-category-required',
    );
  }

  if (input.action === 'EDIT' && !input.geometry) {
    throw new HttpError(
      422,
      'An edited geometry is required',
      'EDIT must supply the corrected polygon.',
      'https://varuna.dev/problems/review-geometry-required',
    );
  }

  const previousGeometry = doc.geometry;
  let geometryChanged = false;

  if (input.action === 'EDIT' && input.geometry) {
    const corrected = rewindPolygon(input.geometry);
    // The area is recomputed geodesically from the corrected outline: an analyst who
    // redraws a slick must get the true area of what they drew, not the model's old figure.
    doc.geometry = corrected as never;
    doc.areaKm2 = geodesicPolygonAreaKm2(corrected) as number;
    geometryChanged = true;
  }

  // Carried only on REJECT: a category on a CONFIRM would be meaningless and would show up
  // in the label export as a negative on a detection nobody rejected.
  const category = input.action === 'REJECT' ? input.rejectionCategory : undefined;

  doc.reviewStatus = STATUS_FOR[input.action] as never;
  doc.reviewHistory.push({
    userId: new Types.ObjectId(input.actorId),
    action: input.action,
    at: new Date(),
    note: input.note,
    rejectionCategory: category,
    // The pre-edit outline is captured in the history entry itself, so the model's original
    // output survives inside the record that changed it.
    geometryBefore: geometryChanged ? previousGeometry : undefined,
  } as never);

  await doc.save();

  await audit({
    actorId: input.actorId,
    action: `DETECTION_${input.action}`,
    entityType: 'SpillDetection',
    entityId: String(doc._id),
    before: { reviewStatus: STATUS_FOR[input.action], areaKm2: doc.areaKm2 },
    after: {
      reviewStatus: doc.reviewStatus,
      areaKm2: doc.areaKm2,
      note: input.note,
      rejectionCategory: category,
    },
    requestId: input.requestId,
  });

  return {
    detectionId: String(doc._id),
    reviewStatus: String(doc.reviewStatus),
    version: doc.reviewHistory.length,
    areaKm2: doc.areaKm2,
    geometryChanged,
    rejectionCategory: category,
    trainingClass: category ? trainingClassFor(category) : undefined,
  };
}

export interface DetectionVersion {
  version: number;
  action: string;
  at: string;
  userId: string | null;
  note?: string;
  rejectionCategory?: string;
  geometry: unknown;
  isModelOutput: boolean;
}

/**
 * Full version history, oldest first, with version 0 being the model's own output.
 *
 * Reconstructed by walking `reviewHistory`: each EDIT entry stores the geometry as it was
 * BEFORE that edit, so version 0's geometry is the `geometryBefore` of the earliest edit,
 * and the current document holds the latest.
 */
export async function detectionVersions(detectionId: string): Promise<DetectionVersion[]> {
  const doc = await SpillDetectionModel.findById(detectionId).lean();
  if (!doc) throw new NotFoundError('Detection not found');

  const history = (doc.reviewHistory ?? []) as Array<{
    userId?: unknown;
    action: string;
    at: Date;
    note?: string;
    rejectionCategory?: string;
    geometryBefore?: unknown;
  }>;

  const firstEdit = history.find((h) => h.action === 'EDIT' && h.geometryBefore);

  const versions: DetectionVersion[] = [
    {
      version: 0,
      action: 'MODEL_OUTPUT',
      at: (doc.createdAt as Date | undefined)?.toISOString() ?? '',
      userId: null,
      geometry: firstEdit?.geometryBefore ?? doc.geometry,
      isModelOutput: true,
    },
  ];

  history.forEach((h, i) => {
    const laterEdit = history.slice(i + 1).find((x) => x.action === 'EDIT' && x.geometryBefore);
    versions.push({
      version: i + 1,
      action: h.action,
      at: h.at instanceof Date ? h.at.toISOString() : String(h.at),
      userId: h.userId ? String(h.userId) : null,
      note: h.note,
      rejectionCategory: h.rejectionCategory,
      // A version's geometry is whatever the NEXT edit recorded as its "before"; if there is
      // no later edit, this version's geometry is the document's current one.
      geometry: laterEdit?.geometryBefore ?? doc.geometry,
      isModelOutput: false,
    });
  });

  return versions;
}
