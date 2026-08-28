import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * `audit_log` — append-only, immutable at the application layer, write-protected at the
 * DB-user level in deployment (02_TRD SEC-12, 01_PRD NFR-14). Every mutating service method
 * writes one entry: who, what, when, before, after.
 */
const AuditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    requestId: String,
    at: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

AuditLogSchema.index({ actorId: 1, at: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1 });

for (const op of [
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const) {
  AuditLogSchema.pre(op, function (next) {
    next(new Error('audit_log is append-only'));
  });
}

export type AuditLog = InferSchemaType<typeof AuditLogSchema>;
export const AuditLogModel = model('AuditLog', AuditLogSchema);
