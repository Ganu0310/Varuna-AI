import { Provenance } from '@varuna/shared';
import { ProvenanceRecordModel } from './model.js';

export type ProvenanceInput = Omit<Provenance, 'retrievedAt'> & { retrievedAt?: string | Date };

/**
 * Record an immutable provenance entry and return its id. Every observed/derived document's
 * embedded `provenance` references one of these (13_REAL_DATA_POLICY §13.5). De-duplicated
 * on `externalId` so re-ingesting the same real artefact does not create a second record.
 */
export async function recordProvenance(input: ProvenanceInput): Promise<string> {
  const parsed = Provenance.parse({
    ...input,
    retrievedAt: (input.retrievedAt ? new Date(input.retrievedAt) : new Date()).toISOString(),
  });

  const existing = await ProvenanceRecordModel.findOne({
    externalId: parsed.externalId,
    provider: parsed.provider,
    datasetId: parsed.datasetId,
  })
    .select({ _id: 1 })
    .lean();
  if (existing) return String(existing._id);

  const doc = await ProvenanceRecordModel.create({
    ...parsed,
    retrievedAt: new Date(parsed.retrievedAt),
  });
  return String(doc._id);
}

/** Provenance sub-document for a DERIVED value, pointing at its parents' provenance ids. */
export function derivedProvenance(
  externalId: string,
  parentIds: string[],
  datasetId = 'attribution',
) {
  return {
    sourceType: 'DERIVED' as const,
    provider: 'VARUNA',
    datasetId,
    externalId,
    retrievedAt: new Date().toISOString(),
    licence: 'internal',
    derivedFrom: parentIds,
  };
}
