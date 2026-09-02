import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MANDATORY_REPORT_SECTIONS } from '@varuna/shared';
import { rbac, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { audit } from '../audit/service.js';
import { ALL_SECTIONS, buildReportData, enforceMandatorySections } from './service.js';
import { toCsv, toGeoJson, toManifest } from './exports.js';
import { enqueue } from '../../queue/producer.js';
import { env } from '../../env.js';
import { NotFoundError } from '../../errors.js';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Reports and exports — 06_BACKEND §6.4.9. */
export const reportsRouter: Router = Router();

const IdParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

/**
 * The section list is validated so that omitting a mandatory section is a 422 at the
 * boundary, before any work happens. The service and the export path enforce it again —
 * three independent checks, because this is the guarantee most worth defending in depth.
 */
const GenerateBody = z
  .object({
    sections: z.array(z.enum(ALL_SECTIONS)).min(1),
    title: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((v) => MANDATORY_REPORT_SECTIONS.every((m) => v.sections.includes(m)), {
    message:
      'UNCERTAINTY and PROVENANCE are mandatory. A report that names a vessel without stating ' +
      'the limits of the analysis, or where its numbers came from, misrepresents the finding.',
    path: ['sections'],
  });

reportsRouter.get(
  '/:id/report/data',
  rbac('viewer'),
  validate({
    params: IdParam,
    query: z.object({ sections: z.string().optional() }).strict(),
  }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = validatedQuery<{ sections?: string }>(req);
      const requested = q.sections ? q.sections.split(',') : [...ALL_SECTIONS];
      const data = await buildReportData(param(req, 'id'), enforceMandatorySections(requested));
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.post(
  '/:id/report/generate',
  rbac('analyst'),
  validate({ params: IdParam, body: GenerateBody }),
  requireInvestigationAccess('analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      const sections = enforceMandatorySections(req.body.sections);
      // Building the data now validates the whole chain, so a generate request fails fast
      // rather than producing a half-empty PDF minutes later.
      const data = await buildReportData(id, sections);

      await audit({
        actorId: req.user!.id,
        action: 'REPORT_GENERATED',
        entityType: 'Investigation',
        entityId: id,
        after: { sections, manifest: data.manifest },
        requestId: reqId(req),
      });

      const { jobId, deduplicated } = await enqueue({
        queue: 'report',
        kind: 'REPORT',
        jobKey: `report:${id}:${sections.join(',')}`,
        payload: { investigationId: id, sections, userId: req.user!.id },
        investigationId: id,
        userId: req.user!.id,
      });

      res.status(deduplicated ? 200 : 202).json({
        jobId,
        deduplicated,
        sections,
        manifest: data.manifest,
        // Still offered: the route each PDF is printed FROM. A reader who wants to read the
        // document rather than file it should not have to wait for a browser to boot.
        printUrl: `/investigations/${id}/report`,
        pdfUrl: `/api/v1/investigations/${id}/report/pdf`,
        // The plain-language brief is generated in the same job, not on request — see
        // `apps/worker/src/processors/report.ts`. It is not optional the way SUMMARY or
        // EVIDENCE are: there is no `sections` entry that omits it.
        printPlainUrl: `/investigations/${id}/report/plain`,
        plainPdfUrl: `/api/v1/investigations/${id}/report/plain/pdf`,
      });
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/:id/exports/geojson',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await buildReportData(param(req, 'id'), [...ALL_SECTIONS]);
      res.setHeader('Content-Type', 'application/geo+json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="varuna-${param(req, 'id')}.geojson"`,
      );
      res.send(JSON.stringify(toGeoJson(data), null, 2));
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/:id/exports/csv',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await buildReportData(param(req, 'id'), [...ALL_SECTIONS]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="varuna-candidates-${param(req, 'id')}.csv"`,
      );
      res.send(toCsv(data));
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/:id/exports/manifest',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await buildReportData(param(req, 'id'), [...ALL_SECTIONS]);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(toManifest(data), null, 2));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Serve the most recent rendered PDF matching a filename pattern.
 *
 * Both PDF routes below share this rather than duplicating the disk logic, but they must
 * NOT share the same filter: `{id}-{iso}.pdf` (the dossier) and `{id}-plain-{iso}.pdf` (the
 * brief) both start with `{id}-`, so a naive prefix match on the dossier route would pick up
 * the newer of the two documents regardless of which one was actually asked for — silently
 * serving one report as the other. `exclude` is how the dossier route rules the brief's
 * files back out.
 *
 * Served from disk rather than redirecting to object storage, because there is no object
 * storage in the API and a signed URL to a file the API is already authorised to read would
 * be indirection for its own sake. `rbac('viewer')` plus `requireInvestigationAccess` — the
 * same gate as every other read of this investigation — is enforced by each caller.
 *
 * Returns the most recent render. Reports are not versioned here: the manifest inside the
 * document (or, for the brief, the dossier's own manifest section) records what it was built
 * from, and the file's SHA-256 is in the job result, so a PDF someone is holding can always
 * be matched back to the run that produced it.
 */
async function servePdf(
  id: string,
  opts: { prefix: string; exclude?: string; noneRenderedDetail: string },
  res: Response,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(env.REPORTS_DIR);
  } catch {
    names = [];
  }

  const mine = names
    .filter((n) => n.startsWith(opts.prefix) && n.endsWith('.pdf'))
    .filter((n) => !opts.exclude || !n.startsWith(opts.exclude))
    .sort();
  const newest = mine[mine.length - 1];
  if (!newest) throw new NotFoundError(opts.noneRenderedDetail);

  // `basename` defends the join against a name that somehow contained a traversal. The ids
  // are validated hex and the files are written by us, so this is belt-and-braces — but a
  // path built from directory contents is exactly where that goes wrong.
  const path = join(env.REPORTS_DIR, basename(newest));
  const info = await stat(path);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', info.size);
  res.setHeader('Content-Disposition', `attachment; filename="${basename(newest)}"`);
  createReadStream(path).pipe(res);
}

reportsRouter.get(
  '/:id/report/pdf',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await servePdf(
        id,
        {
          prefix: `${id}-`,
          exclude: `${id}-plain-`,
          noneRenderedDetail:
            'No PDF has been rendered for this investigation yet. POST to ' +
            `/investigations/${id}/report/generate first, then retry once the job completes.`,
        },
        res,
      );
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The plain-language brief as a PDF — the same document a non-specialist reader gets from
 * `/investigations/:id/report/plain`, ready to hand over or attach to an email without
 * anyone having to open the app first.
 */
reportsRouter.get(
  '/:id/report/plain/pdf',
  rbac('viewer'),
  validate({ params: IdParam }),
  requireInvestigationAccess('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = param(req, 'id');
      await servePdf(
        id,
        {
          prefix: `${id}-plain-`,
          noneRenderedDetail:
            'No plain-language PDF has been rendered for this investigation yet. POST to ' +
            `/investigations/${id}/report/generate first, then retry once the job completes.`,
        },
        res,
      );
    } catch (err) {
      next(err);
    }
  },
);
