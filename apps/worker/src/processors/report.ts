import type { Job } from 'bullmq';
import {
  buildReportData,
  enforceMandatorySections,
} from '@varuna/api/src/modules/reports/service.js';
import { toCsv, toGeoJson, toManifest } from '@varuna/api/src/modules/reports/exports.js';

/**
 * `report` queue processor.
 *
 * Assembles the dossier data and the three machine-readable exports. The mandatory sections
 * are enforced here too — the third of three independent checks — because this is the last
 * point before bytes are written, and a report artefact that reached storage without its
 * uncertainty statement would outlive the request that created it.
 */
export interface ReportJobData {
  investigationId: string;
  sections: string[];
}

export async function processReport(job: Job<ReportJobData>) {
  await job.updateProgress({ pct: 20, stage: 'ASSEMBLING', message: 'Gathering evidence' });

  const sections = enforceMandatorySections(job.data.sections);
  const data = await buildReportData(job.data.investigationId, sections);

  await job.updateProgress({ pct: 70, stage: 'EXPORTS', message: 'Building exports' });

  const geojson = toGeoJson(data);
  const csv = toCsv(data);
  const manifest = toManifest(data);

  await job.updateProgress({ pct: 100, stage: 'COMPLETE' });

  return {
    investigationId: job.data.investigationId,
    sections,
    manifest,
    sizes: {
      geojsonBytes: JSON.stringify(geojson).length,
      csvBytes: csv.length,
      manifestBytes: JSON.stringify(manifest).length,
    },
    uncertaintyStatementCount: data.uncertainty.statements.length,
    provenanceRecordCount: data.provenanceAppendix.records.length,
  };
}
