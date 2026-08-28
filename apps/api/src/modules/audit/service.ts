import { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { AuditLogModel } from './model.js';

export interface AuditEntry {
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}

/**
 * Append-only audit trail — 01_PRD NFR-14 / FR-9.3, 02_TRD SEC-12.
 * Called from every mutating service method. Auditing must never break the operation it
 * records, so a write failure is logged loudly rather than thrown.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      actorId:
        entry.actorId && Types.ObjectId.isValid(entry.actorId)
          ? new Types.ObjectId(entry.actorId)
          : undefined,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
      requestId: entry.requestId,
      at: new Date(),
    });
  } catch (err) {
    logger.error({ err, entry }, 'AUDIT WRITE FAILED — action proceeded but was not recorded');
  }
}

export interface AuditQuery {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export async function listAudit(q: AuditQuery) {
  const filter: Record<string, unknown> = {};
  if (q.actorId && Types.ObjectId.isValid(q.actorId))
    filter.actorId = new Types.ObjectId(q.actorId);
  if (q.entityType) filter.entityType = q.entityType;
  if (q.entityId) filter.entityId = q.entityId;
  return AuditLogModel.find(filter)
    .sort({ at: -1 })
    .limit(Math.min(q.limit ?? 100, 500))
    .lean();
}
