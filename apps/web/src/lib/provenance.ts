import { PROVENANCE_REQUIRED_TYPES, hasValidProvenance } from '@varuna/shared';

/**
 * Client-side real-data enforcement (05_FRONTEND §5.7, 13_REAL_DATA_POLICY §13.4 L4).
 * `apiFetch` calls `assertProvenance(data)` before the data can reach a component; any
 * provenance-required object without a verifiable source record throws here.
 */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

const REQUIRED = new Set<string>(PROVENANCE_REQUIRED_TYPES);

/** Heuristic: an object the server stripped is marked; a domain object names its `__typename`. */
function typeNameOf(obj: Record<string, unknown>): string | null {
  const t = obj['__typename'] ?? obj['_type'];
  return typeof t === 'string' ? t : null;
}

export function assertProvenance(data: unknown, seen = new WeakSet<object>()): void {
  if (Array.isArray(data)) {
    data.forEach((d) => assertProvenance(d, seen));
    return;
  }
  if (data === null || typeof data !== 'object') return;
  if (seen.has(data)) return;
  seen.add(data);

  const obj = data as Record<string, unknown>;

  if (obj['__provenanceMissing'] === true) {
    throw new ProvenanceError(
      `Object ${String(obj['_id'])} was stripped by the server: no verifiable source record.`,
    );
  }

  const typeName = typeNameOf(obj);
  const looksLikeDomainObject =
    'provenance' in obj || (typeName !== null && REQUIRED.has(typeName));
  if (looksLikeDomainObject && !hasValidProvenance(obj)) {
    throw new ProvenanceError(
      `${typeName ?? 'object'} ${String(obj['_id'] ?? '')} has no valid provenance`,
    );
  }

  for (const v of Object.values(obj)) assertProvenance(v, seen);
}

export { hasValidProvenance };
