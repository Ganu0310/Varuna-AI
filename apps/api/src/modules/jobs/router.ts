import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { rbac, canAccessInvestigation } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { NotFoundError, ForbiddenError } from '../../errors.js';
import { cancelJob, retryJob } from '../../queue/producer.js';
import { JobModel } from './model.js';

/** Jobs — 06_BACKEND §6.4.10. */
export const jobsRouter: Router = Router();

const ListJobsQuery = z
  .object({
    investigationId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    status: z
      .enum(['QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
type ListJobsQuery = z.infer<typeof ListJobsQuery>;

const JobIdParam = z.object({ id: z.string().min(1).max(200) });

/** A job is visible only to someone who can see the investigation it belongs to. */
async function assertJobVisible(req: Request, jobKey: string) {
  const job = await JobModel.findOne({ jobKey }).lean();
  if (!job) throw new NotFoundError('Job not found');
  if (job.investigationId) {
    const ok = await canAccessInvestigation(req.user!, String(job.investigationId));
    if (!ok) throw new NotFoundError('Job not found');
  } else if (req.user!.role !== 'admin') {
    throw new ForbiddenError('Only an admin can view unscoped jobs');
  }
  return job;
}

jobsRouter.get(
  '/',
  rbac('viewer'),
  validate({ query: ListJobsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<ListJobsQuery>(req);
      const filter: Record<string, unknown> = {};

      if (q.investigationId) {
        const ok = await canAccessInvestigation(req.user!, q.investigationId);
        if (!ok) throw new NotFoundError('Investigation not found');
        filter.investigationId = new Types.ObjectId(q.investigationId);
      } else if (req.user!.role !== 'admin') {
        // Without an investigation scope, a non-admin only sees jobs they created.
        filter.createdBy = new Types.ObjectId(req.user!.id);
      }
      if (q.status) filter.status = q.status;

      const items = await JobModel.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean();
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

jobsRouter.get(
  '/:id',
  rbac('viewer'),
  validate({ params: JobIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await assertJobVisible(req, param(req, 'id')));
    } catch (err) {
      next(err);
    }
  },
);

jobsRouter.post(
  '/:id/cancel',
  rbac('analyst'),
  validate({ params: JobIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await assertJobVisible(req, id);
      const ok = await cancelJob(id);
      if (!ok) throw new NotFoundError('Job not found');
      res.json({ jobId: id, status: 'CANCELLED' });
    } catch (err) {
      next(err);
    }
  },
);

jobsRouter.post(
  '/:id/retry',
  rbac('analyst'),
  validate({ params: JobIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await assertJobVisible(req, id);
      const ok = await retryJob(id);
      if (!ok) throw new NotFoundError('Job not found');
      res.json({ jobId: id, status: 'QUEUED' });
    } catch (err) {
      next(err);
    }
  },
);
