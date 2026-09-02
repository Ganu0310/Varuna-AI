import type { Job } from 'bullmq';
import {
  buildReportData,
  enforceMandatorySections,
} from '@varuna/api/src/modules/reports/service.js';
import { toCsv, toGeoJson, toManifest } from '@varuna/api/src/modules/reports/exports.js';
import { env } from '@varuna/api/src/env.js';
import { renderReportPdf, renderPlainReportPdf } from './renderPdf.js';

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
  /** Attributed in the audit log; the render itself gets no more than viewer access. */
  userId: string;
  /** Skip the PDF and return data plus exports only. Used by the integration test, which
   *  has no web server to print from. */
  skipPdf?: boolean;
}

export async function processReport(job: Job<ReportJobData>) {
  await job.updateProgress({ pct: 20, stage: 'ASSEMBLING', message: 'Gathering evidence' });

  const sections = enforceMandatorySections(job.data.sections);
  const data = await buildReportData(job.data.investigationId, sections);

  await job.updateProgress({ pct: 70, stage: 'EXPORTS', message: 'Building exports' });

  const geojson = toGeoJson(data);
  const csv = toCsv(data);
  const manifest = toManifest(data);

  // The PDFs last, because rendering is the only step that can fail for reasons outside this
  // service — a browser that will not start, a web app that is not being served. The exports
  // above are already complete by then, so a print failure costs a PDF and not the whole
  // report. The two documents are rendered and reported on independently: the plain-language
  // brief is not a section of the dossier, so one failing must never hide whether the other
  // succeeded.
  let pdf: Awaited<ReturnType<typeof renderReportPdf>> | null = null;
  let pdfUnavailableReason: string | null = null;
  let plainPdf: Awaited<ReturnType<typeof renderPlainReportPdf>> | null = null;
  let plainPdfUnavailableReason: string | null = null;

  if (job.data.skipPdf) {
    pdfUnavailableReason = 'skipped by request';
    plainPdfUnavailableReason = 'skipped by request';
  } else {
    const renderInput = {
      investigationId: job.data.investigationId,
      userId: job.data.userId,
      appUrl: env.PUBLIC_APP_URL,
      outputDir: env.REPORTS_DIR,
    };
    try {
      pdf = await renderReportPdf({
        ...renderInput,
        onProgress: (pct, message) =>
          job.updateProgress({ pct: 70 + Math.round(pct * 0.15), stage: 'RENDERING', message }),
      });
    } catch (e) {
      // Named, never swallowed. "No PDF" and "a PDF that is missing its uncertainty
      // section" must not look the same to whoever reads this job's result.
      pdfUnavailableReason = e instanceof Error ? e.message : String(e);
    }
    try {
      plainPdf = await renderPlainReportPdf({
        ...renderInput,
        onProgress: (pct, message) =>
          job.updateProgress({
            pct: 85 + Math.round(pct * 0.15),
            stage: 'RENDERING_PLAIN',
            message,
          }),
      });
    } catch (e) {
      plainPdfUnavailableReason = e instanceof Error ? e.message : String(e);
    }
  }

  await job.updateProgress({ pct: 100, stage: 'COMPLETE' });

  return {
    investigationId: job.data.investigationId,
    sections,
    manifest,
    sizes: {
      geojsonBytes: JSON.stringify(geojson).length,
      csvBytes: csv.length,
      manifestBytes: JSON.stringify(manifest).length,
      pdfBytes: pdf?.bytes ?? null,
      plainPdfBytes: plainPdf?.bytes ?? null,
    },
    pdf: pdf
      ? { path: pdf.path, sha256: pdf.sha256, renderedAt: pdf.renderedAt }
      : { path: null, unavailableReason: pdfUnavailableReason },
    plainPdf: plainPdf
      ? { path: plainPdf.path, sha256: plainPdf.sha256, renderedAt: plainPdf.renderedAt }
      : { path: null, unavailableReason: plainPdfUnavailableReason },
    uncertaintyStatementCount: data.uncertainty.statements.length,
    provenanceRecordCount: data.provenanceAppendix.records.length,
  };
}
