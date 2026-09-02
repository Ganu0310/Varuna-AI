import { Router, type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ROLES } from '@varuna/shared';
import { rbac } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { NotFoundError } from '../../errors.js';
import { audit, listAudit } from '../audit/service.js';
import { UserModel } from '../auth/model.js';
import { InvestigationModel, REAL_CASE_FILTER } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { detectionLabels } from '../detections/labels.js';
import { TrainingLabelQuery } from './schema.js';
import { OriginEstimateModel } from '../origin/model.js';
import { CandidateVesselModel } from '../candidates/model.js';
import { toPublicUser } from '../auth/service.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { quotaTracker } from '../../providers/quota.js';
import { listRenderedReports, reportChecksum, resolveReportPath } from '../reports/registry.js';
import { ALL_SATELLITE_PROVIDERS } from '../../providers/chain.js';

/** Admin — 06_BACKEND §6.4.10. Every route is admin-only. */
export const adminRouter: Router = Router();

adminRouter.use(rbac('admin'));

adminRouter.get('/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await UserModel.find().sort({ createdAt: -1 }).limit(200);
    res.json({ items: users.map(toPublicUser), nextCursor: null });
  } catch (err) {
    next(err);
  }
});

const SetRoleBody = z.object({ role: z.enum(ROLES) }).strict();
const UserIdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

adminRouter.post(
  '/users/:id/role',
  validate({ params: UserIdParam, body: SetRoleBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await UserModel.findById(param(req, 'id'));
      if (!user) throw new NotFoundError('User not found');
      const before = user.role;
      user.role = req.body.role;
      await user.save();
      await audit({
        actorId: req.user!.id,
        action: 'ADMIN_SET_ROLE',
        entityType: 'User',
        entityId: String(user._id),
        before: { role: before },
        after: { role: user.role },
        requestId: reqId(req),
      });
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

const AuditQuery = z
  .object({
    actorId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    entityType: z.string().max(80).optional(),
    entityId: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
type AuditQuery = z.infer<typeof AuditQuery>;

adminRouter.get(
  '/audit',
  validate({ query: AuditQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await listAudit(validatedQuery<AuditQuery>(req));
      res.json({ items, nextCursor: null });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Provider health and quota consumption — 06_BACKEND §6.5.
 *
 * These were stubs returning `NOT_CONFIGURED` with "Provider clients are introduced in
 * Phase 3". That was honest when written and became false when Phase 3 shipped: the chain
 * has been contacting real providers for some time, and an admin screen reporting "no
 * provider has been contacted yet" while the catalogue is actively querying three of them
 * is worse than no screen at all.
 */
adminRouter.get('/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const quotas = await quotaTracker.snapshotAll();
    res.json({
      items: ALL_SATELLITE_PROVIDERS.map((p) => {
        const health = p.health();
        return { ...health, quotas: quotas.filter((q) => q.quotaKey.startsWith(`${p.name}:`)) };
      }),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/quotas', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await quotaTracker.snapshotAll();
    res.json({
      items,
      // `used: null` means the counter could not be read, which is NOT the same as zero
      // consumption — the admin screen must be able to tell those apart.
      note:
        'Soft limits, set below each provider’s real fair-use ceiling. A null `used` means ' +
        'the counter was unreachable, not that nothing has been consumed.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Every rendered dossier on disk — 14 Phase 12.
 *
 * `GET /investigations/:id/report/pdf` can only find a PDF whose investigation still exists,
 * because it locates the file by scanning for that id. When a case is deleted or a database
 * is re-seeded the rendered document survives on disk and becomes reachable through no route
 * at all. This is where those come back.
 *
 * ADMIN-ONLY, and the reason matters: the per-investigation route is gated on membership
 * (`requireInvestigationAccess`), and an orphan has no investigation left to be a member of,
 * so there is no membership left to check. Falling back to the admin role is the only
 * remaining honest boundary — an admin already sees every user, the audit log and provider
 * state. Each download is written to the audit log, because a report names vessels and
 * reading one outside the case that produced it is exactly the access an auditor would want
 * to see recorded.
 */
adminRouter.get('/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await listRenderedReports();
    const orphaned = items.filter((i) => i.orphaned).length;
    res.json({
      items,
      orphaned,
      note:
        orphaned > 0
          ? `${orphaned} of ${items.length} rendered dossier(s) reference an investigation ` +
            'that no longer exists. The files are intact and downloadable here; they are ' +
            'unreachable through the per-investigation route because the case they belong ' +
            'to is gone.'
          : 'Every rendered dossier still has the investigation it was built from.',
    });
    await audit({
      actorId: req.user!.id,
      action: 'ADMIN_LIST_REPORTS',
      entityType: 'Report',
      entityId: 'all',
      after: { count: items.length, orphaned },
      requestId: reqId(req),
    });
  } catch (err) {
    next(err);
  }
});

const ReportFileParam = z.object({ filename: z.string().max(200) });

adminRouter.get(
  '/reports/:filename',
  validate({ params: ReportFileParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested = param(req, 'filename');
      const path = await resolveReportPath(requested);
      if (!path) {
        throw new NotFoundError(
          `No rendered dossier named "${basename(requested)}". List them at /api/v1/admin/reports.`,
        );
      }

      const info = await stat(path);
      const sha256 = await reportChecksum(path);

      await audit({
        actorId: req.user!.id,
        action: 'ADMIN_DOWNLOAD_REPORT',
        entityType: 'Report',
        entityId: basename(path),
        after: { sizeBytes: info.size, sha256 },
        requestId: reqId(req),
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', info.size);
      // The checksum travels with the file so a printed dossier can be matched back to the
      // exact bytes that produced it.
      res.setHeader('X-Report-SHA256', sha256);
      res.setHeader('Content-Disposition', `attachment; filename="${basename(path)}"`);
      createReadStream(path).pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The labelled training set that analyst review has produced — 07_AIML §7.2.12.
 *
 * ADMIN-ONLY, and for one reason: this is the only route in the system that deliberately
 * crosses investigation boundaries. A training set is worthless confined to one case —
 * it is the accumulation across every case that makes it a set — and there is no
 * membership that spans them. The admin role is the honest boundary, and the read is
 * audited, because assembling every reviewed detection on the instance into one document
 * is exactly the access an auditor would want recorded.
 *
 * `summary` is the part that matters day to day. It answers "have we accumulated enough to
 * retrain, and against which class are we short?" — and it answers it in counts, so the
 * decision to retrain is never made on a feeling that we have "plenty by now".
 */
adminRouter.get(
  '/training-labels',
  validate({ query: TrainingLabelQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<TrainingLabelQuery>(req);
      const { items, unusable, summary } = await detectionLabels(q);

      res.json({
        items,
        // Reported, not dropped. A rejection that cannot be trained on is still a decision
        // somebody made, and a set that quietly shed 40% of its input would misrepresent
        // how much review work has actually been done.
        unusable,
        summary,
        note:
          'Assembled from review actions on real detections; nothing here is generated. A ' +
          'confirmed detection is a positive, a categorised look-alike rejection is a ' +
          'negative, and an operational rejection is neither. Nothing is trained ' +
          'automatically — a retrained model must still beat the shipped detector on the ' +
          'held-out split before it ships.',
      });

      await audit({
        actorId: req.user!.id,
        action: 'ADMIN_EXPORT_TRAINING_LABELS',
        entityType: 'SpillDetection',
        entityId: q.investigationId ?? 'all',
        after: { usable: summary.usable, unusable: summary.unusable.count },
        requestId: reqId(req),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Every investigation on the instance, with how far each one actually got — 06_BACKEND §6.4.10.
 *
 * The scoped list at `GET /investigations` already returns everything to an admin (the
 * membership filter is skipped for that role), so this is NOT about access. It is about a
 * different question. That list answers "which cases can I open?"; an operator needs to
 * answer "which cases are stuck, and where?" — and for that, a title and a status are not
 * enough, because `IN_PROGRESS` covers both a case waiting on an analyst and a case whose
 * ingest died three stages ago.
 *
 * So each row carries the per-stage counts. A case with scenes but no detections stalled at
 * detection; one with an origin but no candidates stalled at correlation; one with nothing
 * never started. That is visible here and nowhere else.
 *
 * Owner emails are resolved in one query rather than per row, and an owner who no longer
 * exists is reported as such instead of being silently blanked — a case whose creator was
 * deleted is exactly the kind of orphan an operator is looking for.
 */
adminRouter.get('/investigations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Excludes Discover's sweep-container investigations — see `REAL_CASE_FILTER`'s own
    // comment. They are not orphans; they are supposed to have no owning analyst, and belong
    // on a future Discover admin view, not this one.
    const items = await InvestigationModel.find({ ...REAL_CASE_FILTER }, { aoi: 0 })
      .sort({ _id: -1 })
      .limit(200)
      .lean();

    const ids = items.map((i) => i._id);
    const ownerIds = [...new Set(items.map((i) => String(i.createdBy)).filter(Boolean))];

    // One grouped count per collection rather than four queries per investigation: at 200
    // rows that difference is 800 round trips against 4.
    const countBy = async (model: {
      aggregate: (p: unknown[]) => { exec: () => Promise<{ _id: unknown; n: number }[]> };
    }): Promise<Map<string, number>> => {
      const rows = await model
        .aggregate([
          { $match: { investigationId: { $in: ids } } },
          { $group: { _id: '$investigationId', n: { $sum: 1 } } },
        ])
        .exec();
      return new Map(rows.map((r) => [String(r._id), r.n]));
    };

    const [scenes, detections, origins, candidates, owners, reports] = await Promise.all([
      countBy(SatelliteSceneModel as never),
      countBy(SpillDetectionModel as never),
      countBy(OriginEstimateModel as never),
      countBy(CandidateVesselModel as never),
      UserModel.find(
        { _id: { $in: ownerIds.map((o) => new Types.ObjectId(o)) } },
        { email: 1, name: 1 },
      ).lean(),
      listRenderedReports(),
    ]);

    const ownerById = new Map(owners.map((o) => [String(o._id), o]));
    const reportsById = new Map<string, number>();
    for (const r of reports) {
      reportsById.set(r.investigationId, (reportsById.get(r.investigationId) ?? 0) + 1);
    }

    res.json({
      items: items.map((i) => {
        const id = String(i._id);
        const ownerId = i.createdBy ? String(i.createdBy) : null;
        const owner = ownerId ? ownerById.get(ownerId) : undefined;
        return {
          _id: id,
          name: i.name ?? null,
          status: i.status ?? null,
          createdAt: i.createdAt ?? null,
          deletedAt: i.deletedAt ?? null,
          ownerId,
          ownerEmail: owner?.email ?? null,
          ownerName: owner?.name ?? null,
          // A creator who no longer exists. Members are unaffected, but nobody inherits the
          // case, so it needs reassigning before an analyst can be given it.
          ownerMissing: Boolean(ownerId) && !owner,
          memberCount: (i.members ?? []).length,
          counts: {
            scenes: scenes.get(id) ?? 0,
            detections: detections.get(id) ?? 0,
            origins: origins.get(id) ?? 0,
            candidates: candidates.get(id) ?? 0,
            reports: reportsById.get(id) ?? 0,
          },
        };
      }),
      note:
        'Every investigation on this instance, newest first, with per-stage counts so a ' +
        'stalled case shows WHERE it stalled. Counts of 0 across the board mean the chain ' +
        'never started, not that it failed.',
    });

    await audit({
      actorId: req.user!.id,
      action: 'ADMIN_LIST_INVESTIGATIONS',
      entityType: 'Investigation',
      entityId: 'all',
      after: { count: items.length },
      requestId: reqId(req),
    });
  } catch (err) {
    next(err);
  }
});
