import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Types } from 'mongoose';
import { env } from '../../env.js';
import { InvestigationModel } from '../investigations/model.js';

/**
 * What dossiers actually exist on disk — 14 Phase 12.
 *
 * Rendered reports are FILES, not documents: the worker writes `{investigationId}-{iso}.pdf`
 * into `REPORTS_DIR` and nothing records them in MongoDB. That is a deliberate simplification
 * (a report is reproducible from the investigation, so the file is a cache, not a source of
 * truth) with one consequence nobody accounted for:
 *
 *   `GET /investigations/:id/report/pdf` finds a PDF by scanning for its investigation's id.
 *   If the investigation is gone — a dropped database, a re-seed, a deleted case — the file
 *   is still on disk and is reachable by NO route at all. It becomes an orphan: real
 *   evidence, rendered and filed, that the system can no longer hand back to anyone.
 *
 * This module enumerates the directory and reconciles it against the investigations that
 * still exist, so an operator can see both kinds and tell them apart. It deliberately does
 * NOT hide orphans: a dossier that outlived its case is exactly the artefact someone needs
 * to find, and quietly omitting it would be the system losing evidence silently.
 */

export interface RenderedReport {
  filename: string;
  investigationId: string;
  /** Parsed from the filename, which is when the worker finished the render. */
  renderedAt: string | null;
  sizeBytes: number;
  /** Whether the investigation this was rendered from still exists. */
  investigationExists: boolean;
  investigationStatus: string | null;
  /** True when the file survives but its case does not — reachable through no scoped route. */
  orphaned: boolean;
}

/** `{24-hex}-{ISO with colons replaced by dashes}.pdf` — the worker's naming scheme. */
const NAME = /^([a-f\d]{24})-(.+)\.pdf$/i;

function parseRenderedAt(stamp: string): string | null {
  // `2026-08-29T12-34-11-167Z` — colons and the millisecond dot were replaced by dashes to
  // keep the name filesystem-safe, so they have to be put back before Date can read it.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function listRenderedReports(): Promise<RenderedReport[]> {
  let names: string[];
  try {
    names = await readdir(env.REPORTS_DIR);
  } catch {
    // A missing directory means nothing has been rendered yet, which is not an error.
    return [];
  }

  const parsed = names
    .map((n) => ({ n, m: NAME.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null);

  const ids = [...new Set(parsed.map((x) => x.m[1]!.toLowerCase()))];
  const existing = await InvestigationModel.find(
    { _id: { $in: ids.map((i) => new Types.ObjectId(i)) } },
    { status: 1 },
  ).lean();
  const byId = new Map(existing.map((i) => [String(i._id), String(i.status ?? '')]));

  const out: RenderedReport[] = [];
  for (const { n, m } of parsed) {
    const id = m[1]!.toLowerCase();
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(join(env.REPORTS_DIR, basename(n)))).size;
    } catch {
      continue; // vanished between readdir and stat
    }
    const exists = byId.has(id);
    out.push({
      filename: n,
      investigationId: id,
      renderedAt: parseRenderedAt(m[2]!),
      sizeBytes,
      investigationExists: exists,
      investigationStatus: exists ? (byId.get(id) ?? null) : null,
      orphaned: !exists,
    });
  }

  // Newest first — an operator looking for "the last one" should not have to scan.
  out.sort((a, b) => (b.renderedAt ?? '').localeCompare(a.renderedAt ?? ''));
  return out;
}

/**
 * Resolve a filename to a path inside REPORTS_DIR, or null.
 *
 * The name is matched against the directory listing rather than trusted and joined. `basename`
 * alone would stop `../../etc/passwd`, but it would not stop a request for a file that is in
 * the directory and is not a dossier. Requiring an exact match against an enumerated,
 * pattern-checked name means the only reachable files are ones this module already vouched for.
 */
export async function resolveReportPath(filename: string): Promise<string | null> {
  const safe = basename(filename);
  if (!NAME.test(safe)) return null;
  const reports = await listRenderedReports();
  if (!reports.some((r) => r.filename === safe)) return null;
  return join(env.REPORTS_DIR, safe);
}

/** SHA-256 of a rendered PDF, so a document someone is holding can be matched to this file. */
export async function reportChecksum(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
