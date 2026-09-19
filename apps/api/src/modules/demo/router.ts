import { Router, type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { rbac } from '../../middleware/rbac.js';
import { jobCreationLimiter } from '../../middleware/rateLimits.js';
import { reqId } from '../../middleware/requestId.js';
import { enqueue } from '../../queue/producer.js';
import { audit } from '../audit/service.js';
import { createInvestigation } from '../investigations/service.js';
import { importAisCsv } from '../ais/import.js';

/**
 * Demo — one call that stands up the verified Apra Harbour, Guam scenario so it can be
 * driven from the browser (Dashboard → "Run verified Sentinel-1 demo").
 *
 * It uses the SAME code paths as a normal investigation: it creates the investigation,
 * imports the SYNTHETIC demo AIS slice (labelled as such in its provenance), and enqueues
 * the real ingest job. Detection runs automatically on ingest; origin back-track and
 * candidate ranking are then one click each in the workspace. Nothing here is faked.
 */
export const demoRouter: Router = Router();

const DEMO = {
  name: 'Guam — Apra Harbour 2025-09-21',
  incidentReference: 'VARUNA-DEMO-01',
  productId: 'S1C_IW_GRDH_1SDV_20250921T200737_20250921T200800_004227_008638_rtc',
  collection: 'sentinel-1-rtc',
  aoi: [144.55, 13.3, 144.95, 13.6] as [number, number, number, number],
  windowStart: '2025-09-20T00:00:00.000Z',
  windowEnd: '2025-09-23T00:00:00.000Z',
  reportedIncidentAt: '2025-09-21T20:07:48.000Z',
  aisFile: 'data/demo/ais/guam-2025-09-21.demo.csv',
  aisFrom: '2025-09-21T00:00:00.000Z',
  aisTo: '2025-09-22T12:00:00.000Z',
  aisBbox: [144.4, 13.2, 145.1, 13.8] as [number, number, number, number],
};

demoRouter.get('/info', rbac('viewer'), (_req: Request, res: Response) => {
  res.json({
    scenario: DEMO.name,
    reference: DEMO.incidentReference,
    scene: {
      productId: DEMO.productId,
      collection: DEMO.collection,
      platform: 'SENTINEL-1C',
      mode: 'IW',
      polarisations: ['VV', 'VH'],
      orbit: 'DESCENDING',
      acquiredAt: DEMO.reportedIncidentAt,
      source: 'Microsoft Planetary Computer',
      dataClass: 'REAL',
    },
    ais: { source: 'VARUNA synthetic demo AIS', dataClass: 'SYNTHETIC' },
    forcing: { dataClass: 'DEGRADED', note: 'No keyless ocean/wind model covers this date.' },
    aoi: DEMO.aoi,
    stages: ['INGEST', 'DETECT', 'BACKTRACK', 'AIS', 'CORRELATE', 'RANK', 'DOSSIER'],
  });
});

demoRouter.post(
  '/run',
  rbac('analyst'),
  jobCreationLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await createInvestigation(
        {
          name: `${DEMO.name} (${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z)`,
          incidentReference: DEMO.incidentReference,
          aoi: {
            type: 'Polygon',
            coordinates: [
              [
                [DEMO.aoi[0], DEMO.aoi[1]],
                [DEMO.aoi[2], DEMO.aoi[1]],
                [DEMO.aoi[2], DEMO.aoi[3]],
                [DEMO.aoi[0], DEMO.aoi[3]],
                [DEMO.aoi[0], DEMO.aoi[1]],
              ],
            ],
          },
          windowStart: DEMO.windowStart,
          windowEnd: DEMO.windowEnd,
          reportedIncidentAt: DEMO.reportedIncidentAt,
        },
        req.user!,
        reqId(req),
      );
      const investigationId = String(inv._id);

      // Synthetic AIS — fast, synchronous, and labelled so provenance never claims NOAA.
      let aisImported = 0;
      const aisPath = resolve(process.cwd(), DEMO.aisFile);
      if (existsSync(aisPath)) {
        try {
          const r = await importAisCsv({
            filePath: aisPath,
            from: DEMO.aisFrom,
            to: DEMO.aisTo,
            bbox: DEMO.aisBbox,
            source: 'USER_UPLOAD',
            providerLabel: {
              provider: 'VARUNA synthetic demo AIS',
              datasetId: 'demo-ais-guam-2025-09-21',
            },
          });
          aisImported = r.imported;
        } catch {
          /* AIS is not on the critical path for ingest+detect; surface 0 and continue */
        }
      }

      const { jobId, deduplicated } = await enqueue({
        queue: 'ingest',
        kind: 'INGEST',
        jobKey: `ingest:${investigationId}:${DEMO.productId}`,
        payload: {
          investigationId,
          productId: DEMO.productId,
          aoi: DEMO.aoi,
          collection: DEMO.collection,
        },
        investigationId,
        userId: req.user!.id,
      });

      await audit({
        actorId: req.user!.id,
        action: 'SCENE_INGEST_REQUESTED',
        entityType: 'Investigation',
        entityId: investigationId,
        after: { demo: true, productId: DEMO.productId, jobId, aisImported },
        requestId: reqId(req),
      });

      res.status(202).json({
        investigationId,
        jobId,
        deduplicated,
        aisImported,
        productId: DEMO.productId,
        next: 'Ingest + detection are running. Open the workspace to watch, then run back-tracking and ranking.',
      });
    } catch (err) {
      next(err);
    }
  },
);
