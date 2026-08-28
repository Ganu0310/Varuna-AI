import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MANDATORY_REPORT_SECTIONS } from '@varuna/shared';
import { rbac, requireInvestigationAccess } from '../../middleware/rbac.js';
import { validate, validatedQuery, param } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { audit } from '../audit/service.js';
import { ALL_SECTIONS, buildReportData, enforceMandatorySections } from './service.js';
import { toCsv, toGeoJson, toManifest } from './exports.js';

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

      res.status(200).json({
        sections,
        manifest: data.manifest,
        // The print-ready route is the deliverable; a browser prints it to PDF. Headless
        // rendering is wired here when Playwright is available in the deployment image.
        printUrl: `/investigations/${id}/report`,
        note:
          'Open printUrl and print to PDF (A4). The page renders the same components as the ' +
          'workspace, in light theme, with UNCERTAINTY and PROVENANCE always present.',
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
