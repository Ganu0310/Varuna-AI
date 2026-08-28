import { z } from 'zod';
import { JOB_KINDS } from '../constants.js';

/** Job lifecycle — 08_APP_FLOW §8.5.2, 03_ARCHITECTURE §3.6. */
export const JobStatus = z.enum([
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobProgress = z.object({
  jobId: z.string(),
  pct: z.number().min(0).max(100),
  stage: z.string(),
  message: z.string().optional(),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const Job = z.object({
  _id: z.string(),
  /** Deterministic idempotency key, e.g. `ingest:${productId}` (03_ARCHITECTURE §3.6). */
  jobKey: z.string(),
  kind: z.enum(JOB_KINDS),
  queue: z.string(),
  investigationId: z.string().optional(),
  status: JobStatus,
  progress: JobProgress.omit({ jobId: true }).optional(),
  attempts: z.number().int().nonnegative().default(0),
  failureReason: z.string().optional(),
  result: z.record(z.unknown()).optional(),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Job = z.infer<typeof Job>;

/** RFC 9457 problem+json body (06_BACKEND §6.10). */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  attempted: z.array(z.object({ provider: z.string(), outcome: z.string() })).optional(),
  consequence: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
