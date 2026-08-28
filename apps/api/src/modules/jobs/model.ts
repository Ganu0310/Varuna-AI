import { Schema, model, type InferSchemaType } from 'mongoose';
import { JOB_KINDS } from '@varuna/shared';

/**
 * `jobs` mirrors BullMQ state so the UI can query history after the Redis job is evicted
 * (03_ARCHITECTURE §3.6). Lifecycle: QUEUED → RUNNING → (COMPLETED | FAILED | CANCELLED),
 * plus RETRYING. `jobKey` is the deterministic idempotency key.
 */
const JobSchema = new Schema(
  {
    jobKey: { type: String, required: true },
    kind: { type: String, enum: JOB_KINDS, required: true },
    queue: { type: String, required: true },
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', index: true },
    status: {
      type: String,
      enum: ['QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'],
      default: 'QUEUED',
      index: true,
    },
    progress: {
      pct: { type: Number, min: 0, max: 100 },
      stage: String,
      message: String,
    },
    attempts: { type: Number, default: 0 },
    failureReason: String,
    result: Schema.Types.Mixed,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
  },
  { timestamps: true },
);

JobSchema.index({ status: 1, createdAt: -1 });
JobSchema.index({ jobKey: 1 });
// TTL on completed jobs (30 days) — 02_TRD §2.5.1.
JobSchema.index(
  { completedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30, partialFilterExpression: { status: 'COMPLETED' } },
);

export type Job = InferSchemaType<typeof JobSchema>;
export const JobModel = model('Job', JobSchema);
