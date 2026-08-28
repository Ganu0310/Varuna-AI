import type { Request, Response, NextFunction } from 'express';
import { Provenance } from '@varuna/shared';
import { logger } from '../lib/logger.js';

/**
 * Response-level real-data enforcement (13_REAL_DATA_POLICY §13.4 L3, 02_TRD TR-P3).
 *
 * Walks every outgoing JSON payload. Any object that carries a `provenance` field must
 * carry a COMPLETE, valid one (validated against the shared Zod schema). An object whose
 * provenance is missing or malformed is STRIPPED — replaced with a
 * `{ _id, __provenanceMissing: true }` marker that the client's <DataObject> renders as a
 * loud "PROVENANCE MISSING" error — and a severity-1 line is logged. It is not emitted with
 * its data intact.
 *
 * Headers:
 *   X-Provenance-Count    — number of valid provenance records in the payload
 *   X-Provenance-Stripped — number of objects stripped (absent when zero)
 */
export function provenanceGuard(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    const stats = { valid: 0, stripped: 0 };
    const cleaned = walk(body, stats, new WeakSet());

    res.setHeader('X-Provenance-Count', String(stats.valid));
    if (stats.stripped > 0) {
      res.setHeader('X-Provenance-Stripped', String(stats.stripped));
      logger.error(
        { requestId: (res.req as Request | undefined)?.id, stripped: stats.stripped },
        'PROVENANCE VIOLATION — object(s) without valid provenance stripped from a response',
      );
    }
    return originalJson(cleaned);
  };

  next();
}

function walk(
  value: unknown,
  stats: { valid: number; stripped: number },
  seen: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, stats, seen));
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  const obj = value as Record<string, unknown>;

  if ('provenance' in obj) {
    const result = Provenance.safeParse(obj.provenance);
    if (result.success) {
      stats.valid += 1;
    } else {
      stats.stripped += 1;
      return { _id: obj._id ?? null, __provenanceMissing: true };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = walk(v, stats, seen);
  return out;
}
