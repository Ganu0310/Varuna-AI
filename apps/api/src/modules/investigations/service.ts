import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import { MAX_AOI_KM2, type Role } from '@varuna/shared';
import { HttpError, NotFoundError, ForbiddenError } from '../../errors.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { audit } from '../audit/service.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { InvestigationModel } from './model.js';
import { CommentModel } from './comments.model.js';
import type {
  CreateInvestigationBody,
  ListInvestigationsQuery,
  UpdateInvestigationBody,
} from './schema.js';

/**
 * AOI guard — 01_PRD A1, 06_BACKEND §6.4.2. The rejection states the ACTUAL area so the
 * analyst knows how much to shrink by, rather than just being told "too big" (04_UIUX §4.11).
 * Area is geodesic, never in degrees (02_TRD TR-3).
 */
export function assertAoiWithinLimit(aoi: Polygon): number {
  const areaKm2 = geodesicPolygonAreaKm2(aoi) as number;
  if (areaKm2 > MAX_AOI_KM2) {
    throw new HttpError(
      422,
      'Area of interest too large',
      `The AOI covers ${areaKm2.toFixed(1)} km², which exceeds the ${MAX_AOI_KM2.toLocaleString()} km² limit. ` +
        `Reduce it by at least ${(areaKm2 - MAX_AOI_KM2).toFixed(1)} km².`,
      'https://varuna.dev/problems/aoi-too-large',
    );
  }
  if (areaKm2 <= 0) {
    throw new HttpError(
      422,
      'Area of interest is degenerate',
      'The AOI polygon has zero area. Draw a region with extent.',
      'https://varuna.dev/problems/aoi-degenerate',
    );
  }
  return areaKm2;
}

export async function createInvestigation(
  input: CreateInvestigationBody,
  actor: { id: string; role: Role },
  requestId?: string,
) {
  // Normalise winding BEFORE measuring or storing (D-011: MongoDB will not do it for us).
  const aoi = rewindPolygon(input.aoi as Polygon);
  const aoiAreaKm2 = assertAoiWithinLimit(aoi);

  const doc = await InvestigationModel.create({
    name: input.name,
    description: input.description,
    incidentReference: input.incidentReference,
    aoi,
    aoiAreaKm2,
    windowStart: new Date(input.windowStart),
    windowEnd: new Date(input.windowEnd),
    reportedIncidentAt: input.reportedIncidentAt ? new Date(input.reportedIncidentAt) : undefined,
    status: 'DRAFT',
    createdBy: new Types.ObjectId(actor.id),
    members: [{ userId: new Types.ObjectId(actor.id), role: 'lead' }],
  });

  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_CREATE',
    entityType: 'Investigation',
    entityId: String(doc._id),
    after: { name: doc.name, aoiAreaKm2, windowStart: doc.windowStart, windowEnd: doc.windowEnd },
    requestId,
  });

  return doc;
}

export async function getInvestigation(id: string) {
  const doc = await InvestigationModel.findOne({ _id: id, deletedAt: null });
  if (!doc) throw new NotFoundError('Investigation not found');
  return doc;
}

export async function listInvestigations(
  q: ListInvestigationsQuery,
  actor: { id: string; role: Role },
) {
  const filter: Record<string, unknown> = { deletedAt: null };

  // Non-admins see only what they created or are a member of.
  if (actor.role !== 'admin') {
    const actorId = new Types.ObjectId(actor.id);
    filter.$or = [{ createdBy: actorId }, { 'members.userId': actorId }];
  }
  if (q.status) filter.status = q.status;
  if (q.from || q.to) {
    filter.createdAt = {
      ...(q.from ? { $gte: new Date(q.from) } : {}),
      ...(q.to ? { $lte: new Date(q.to) } : {}),
    };
  }
  // Cursor pagination on _id (monotonic), newest first.
  if (q.cursor && Types.ObjectId.isValid(q.cursor)) {
    filter._id = { $lt: new Types.ObjectId(q.cursor) };
  }

  const items = await InvestigationModel.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();

  const hasMore = items.length > q.limit;
  const page = hasMore ? items.slice(0, q.limit) : items;
  return {
    items: page,
    nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
  };
}

/**
 * Changing the AOI or the time window invalidates everything computed downstream. We say
 * so explicitly rather than leaving stale scenes and detections attached to a different
 * region (06_BACKEND §6.4.2).
 */
export async function updateInvestigation(
  id: string,
  patch: UpdateInvestigationBody,
  actor: { id: string; role: Role },
  requestId?: string,
) {
  const doc = await getInvestigation(id);
  const before = doc.toObject();

  const scopeChanged = Boolean(patch.aoi || patch.windowStart || patch.windowEnd);

  if (patch.aoi) {
    const aoi = rewindPolygon(patch.aoi as Polygon);
    doc.aoi = aoi as never;
    doc.aoiAreaKm2 = assertAoiWithinLimit(aoi);
  }
  if (patch.name !== undefined) doc.name = patch.name;
  if (patch.description !== undefined) doc.description = patch.description;
  if (patch.incidentReference !== undefined) doc.incidentReference = patch.incidentReference;
  if (patch.windowStart) doc.windowStart = new Date(patch.windowStart);
  if (patch.windowEnd) doc.windowEnd = new Date(patch.windowEnd);
  if (patch.reportedIncidentAt) doc.reportedIncidentAt = new Date(patch.reportedIncidentAt);

  if (doc.windowEnd <= doc.windowStart) {
    throw new HttpError(422, 'Invalid time window', 'windowEnd must be after windowStart');
  }

  await doc.save();

  let invalidated: { scenes: number; detections: number } | undefined;
  if (scopeChanged) {
    const [scenes, detections] = await Promise.all([
      SatelliteSceneModel.countDocuments({ investigationId: doc._id }),
      SpillDetectionModel.countDocuments({ investigationId: doc._id }),
    ]);
    invalidated = { scenes, detections };
  }

  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_UPDATE',
    entityType: 'Investigation',
    entityId: id,
    before: {
      aoiAreaKm2: before.aoiAreaKm2,
      windowStart: before.windowStart,
      windowEnd: before.windowEnd,
    },
    after: { aoiAreaKm2: doc.aoiAreaKm2, windowStart: doc.windowStart, windowEnd: doc.windowEnd },
    requestId,
  });

  return { doc, scopeChanged, invalidated };
}

/** Soft delete — the audit trail must continue to reference the investigation. */
export async function deleteInvestigation(id: string, actor: { id: string }, requestId?: string) {
  const doc = await getInvestigation(id);
  doc.deletedAt = new Date();
  await doc.save();
  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_DELETE',
    entityType: 'Investigation',
    entityId: id,
    requestId,
  });
}

export async function addMember(
  id: string,
  member: { userId: string; role: Role },
  actor: { id: string },
  requestId?: string,
) {
  const doc = await getInvestigation(id);
  const userId = new Types.ObjectId(member.userId);
  const existing = doc.members.find((m) => String(m.userId) === member.userId);
  if (existing) existing.role = member.role;
  else doc.members.push({ userId, role: member.role });
  await doc.save();

  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_MEMBER_SET',
    entityType: 'Investigation',
    entityId: id,
    after: { userId: member.userId, role: member.role },
    requestId,
  });
  return doc;
}

/**
 * Pipeline stage roll-up for the workspace Overview panel (06_BACKEND §6.4.2).
 * Counts are real queries — an empty pipeline reports zeros, it does not fake progress.
 */
export async function investigationSummary(id: string) {
  const doc = await getInvestigation(id);
  const [scenes, detections] = await Promise.all([
    SatelliteSceneModel.countDocuments({ investigationId: doc._id }),
    SpillDetectionModel.countDocuments({ investigationId: doc._id }),
  ]);

  return {
    _id: String(doc._id),
    name: doc.name,
    status: doc.status,
    aoiAreaKm2: doc.aoiAreaKm2,
    window: { start: doc.windowStart, end: doc.windowEnd },
    counts: { scenes, detections },
    stages: {
      SCENES: scenes > 0 ? 'COMPLETE' : 'PENDING',
      DETECTION: detections > 0 ? 'COMPLETE' : 'PENDING',
      ORIGIN: 'PENDING',
      AIS: 'PENDING',
      SCORING: 'PENDING',
    },
  };
}

// ── comments ──────────────────────────────────────────────────────────

/**
 * Post an analytical note — 06_BACKEND §6.4.2.
 *
 * The author's email is denormalised onto the row deliberately. A note is evidence of what
 * someone believed at a point in time, and it has to keep reading correctly after the account
 * is deactivated or renamed; joining to a live user record would let a later change rewrite
 * the attribution on an old statement.
 */
export async function addComment(
  id: string,
  input: { body: string; subjectType?: string | null; subjectId?: string | null },
  actor: { id: string; email: string },
  requestId?: string,
) {
  await getInvestigation(id);

  const doc = await CommentModel.create({
    investigationId: new Types.ObjectId(id),
    authorId: new Types.ObjectId(actor.id),
    authorEmail: actor.email,
    body: input.body,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ? new Types.ObjectId(input.subjectId) : null,
  });

  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_COMMENT_ADDED',
    entityType: 'Investigation',
    entityId: id,
    // The body is NOT copied into the audit log. Duplicating it would mean a retraction has
    // to reach two places to be honoured, and the one it missed would be the one someone
    // eventually reads.
    after: { commentId: String(doc._id), subjectType: doc.subjectType, length: input.body.length },
    requestId,
  });
  return doc;
}

/** Newest last — a conversation reads forwards. */
export async function listComments(id: string, subject?: { type: string; id: string }) {
  await getInvestigation(id);
  const filter: Record<string, unknown> = { investigationId: new Types.ObjectId(id) };
  if (subject) {
    filter.subjectType = subject.type;
    filter.subjectId = new Types.ObjectId(subject.id);
  }
  return CommentModel.find(filter).sort({ createdAt: 1 }).lean();
}

/**
 * Withdraw a note. Only its author may, and a lead may not do it for them.
 *
 * A comment is a record of what a particular person thought. Letting someone else remove it
 * would make the record a record of what the team lead was willing to leave standing, which
 * is a different and much less useful thing. A lead who disagrees can say so in a comment of
 * their own — that is what the thread is for.
 *
 * The row survives; the body is cleared. Deleting outright would leave replies answering
 * nothing, and would hide that a claim was made and withdrawn — itself part of the record.
 */
export async function retractComment(
  id: string,
  commentId: string,
  actor: { id: string },
  requestId?: string,
) {
  await getInvestigation(id);
  const doc = await CommentModel.findOne({
    _id: new Types.ObjectId(commentId),
    investigationId: new Types.ObjectId(id),
  });
  if (!doc) throw new NotFoundError('No such comment on this investigation');

  if (String(doc.authorId) !== actor.id) {
    throw new ForbiddenError('A comment can only be retracted by the analyst who wrote it');
  }
  if (doc.retractedAt) return doc;

  doc.body = '';
  doc.retractedAt = new Date();
  doc.retractedBy = new Types.ObjectId(actor.id);
  await doc.save();

  await audit({
    actorId: actor.id,
    action: 'INVESTIGATION_COMMENT_RETRACTED',
    entityType: 'Investigation',
    entityId: id,
    after: { commentId },
    requestId,
  });
  return doc;
}
