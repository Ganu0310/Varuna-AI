import { chromium, type Browser } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { signReportToken } from '@varuna/api/src/modules/reports/reportToken.js';
import { REPORT_COOKIE } from '@varuna/api/src/middleware/authenticate.js';

/**
 * Prints the dossier route to PDF — 06_BACKEND §6.8, 05_FRONTEND §5.5.10.
 *
 * The PDF is rendered from the same route an analyst reads on screen, rather than assembled
 * from the report data a second time in a PDF library. Two implementations of one document
 * drift, and the way they drift is that the screen grows a caveat the print does not. Since
 * the entire point of the dossier is that its uncertainty and provenance sections cannot be
 * removed, a second renderer that could omit them would defeat the guarantee the other three
 * checks exist to enforce.
 *
 * Consequence, stated plainly: this needs a browser. It is slower and heavier than
 * generating a PDF directly, and it fails if the web app is not being served. That is the
 * price of the artefact matching the screen.
 */

/**
 * `preferCSSPageSize` hands size and margins to the stylesheet's `@page` rule, which already
 * declares A4 at 14 mm. Setting them here as well would mean two sources for one measurement,
 * and the stylesheet is the one written alongside the document that has to fit them.
 *
 * `printBackground` is required, not cosmetic: the dossier encodes confidence tiers and
 * evidence contributions partly in fill, and without backgrounds those become blank boxes.
 */
const PDF_OPTIONS = {
  preferCSSPageSize: true,
  printBackground: true,
};

export interface RenderPdfInput {
  investigationId: string;
  /** The user the render is attributed to in the audit log. */
  userId: string;
  /** Where the SPA is served, e.g. `http://localhost:5173`. */
  appUrl: string;
  /** Directory PDFs are written to. */
  outputDir: string;
  onProgress?: (pct: number, message: string) => Promise<void> | void;
}

export interface RenderPdfResult {
  path: string;
  bytes: number;
  /** SHA-256 of the file, so a report cited in evidence can be shown to be unaltered. */
  sha256: string;
  renderedAt: string;
}

export async function renderReportPdf(input: RenderPdfInput): Promise<RenderPdfResult> {
  const { investigationId, userId, appUrl, outputDir } = input;

  const token = await signReportToken({ sub: userId, investigationId });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      // The report route is specified to print in LIGHT theme (05_FRONTEND §5.5.10): the
      // workspace's dark palette costs a great deal of toner and reads badly photocopied,
      // which is what happens to a document that reaches a court file.
      colorScheme: 'light',
      viewport: { width: 1240, height: 1754 },
    });

    const url = new URL(appUrl);
    await context.addCookies([
      {
        name: REPORT_COOKIE,
        value: token,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const page = await context.newPage();

    // A render that silently swallowed a failed request would produce a dossier with a
    // section quietly missing, which is the one output this system must never emit. Collect
    // failures and refuse afterwards rather than printing a plausible-looking partial.
    const failures: string[] = [];
    page.on('requestfailed', (r) => failures.push(`${r.method()} ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });

    await input.onProgress?.(30, 'Opening dossier');
    await page.goto(`${appUrl}/investigations/${investigationId}/report`, {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });

    // Wait for the sections that may not be omitted, not for a timer. If they are not on the
    // page there is nothing worth printing.
    await page.getByRole('heading', { name: /uncertainty/i }).waitFor({ timeout: 30_000 });
    await page.getByRole('heading', { name: /provenance/i }).waitFor({ timeout: 30_000 });

    if (failures.length > 0) {
      throw new Error(
        `dossier render had ${failures.length} failed request(s), refusing to print a ` +
          `partial report: ${failures.slice(0, 5).join('; ')}`,
      );
    }

    await input.onProgress?.(70, 'Printing');
    const buffer = await page.pdf(PDF_OPTIONS);

    await mkdir(outputDir, { recursive: true });
    const renderedAt = new Date().toISOString();
    const name = `${investigationId}-${renderedAt.replace(/[:.]/g, '-')}.pdf`;
    const path = join(outputDir, name);
    await writeFile(path, buffer);

    return {
      path,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      renderedAt,
    };
  } finally {
    await browser?.close();
  }
}
