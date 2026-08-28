import type { Job } from 'bullmq';
import { importAisCsv } from '@varuna/api/src/modules/ais/import.js';

/**
 * `ais-import` queue processor.
 *
 * A full-year Marine Cadastre CSV is ~350 MB and scanning it takes seconds even when the
 * window filter rejects most rows, so this belongs on the worker rather than in a request.
 * The import itself is idempotent: it clears the exact window and box before inserting, so
 * a retried job replaces its slice instead of doubling it.
 */
export interface AisImportJobData {
  filePath: string;
  from: string;
  to: string;
  bbox: [number, number, number, number];
  source?: string;
}

export async function processAisImport(job: Job<AisImportJobData>) {
  await job.updateProgress({ pct: 10, stage: 'READING', message: 'Scanning the archive' });

  const result = await importAisCsv({
    filePath: job.data.filePath,
    from: job.data.from,
    to: job.data.to,
    bbox: job.data.bbox,
    source: job.data.source,
  });

  await job.updateProgress({
    pct: 100,
    stage: 'COMPLETE',
    message: `${result.imported.toLocaleString()} positions, ${result.distinctMmsi} vessels`,
  });

  return result;
}
