import { Schema } from 'mongoose';
import { SOURCE_TYPES } from '@varuna/shared';

/**
 * The provenance base plugin — the structural guarantee behind 13_REAL_DATA_POLICY.
 *
 * Applied to every model that stores observed or derived data: SatelliteScene,
 * SpillDetection, VesselTrack, OriginEstimate, CandidateVessel, Vessel. A save without a
 * complete `provenance` sub-document is rejected at `pre('validate')` — enforced here, not
 * just documented (06_BACKEND §6.3.1, 13_REAL_DATA_POLICY §13.4 L2).
 *
 * `sourceType` is a closed enum with no MOCK / SYNTHETIC / TEST / DEMO / PLACEHOLDER member
 * (imported from @varuna/shared so the two never drift).
 */
export const ProvenanceSchema = new Schema(
  {
    sourceType: { type: String, required: true, enum: SOURCE_TYPES },
    provider: { type: String, required: true },
    datasetId: { type: String, required: true },
    externalId: { type: String, required: true },
    retrievedAt: { type: Date, required: true },
    licence: { type: String, required: true },
    accessUrl: String,
    checksum: String,
    derivedFrom: [{ type: Schema.Types.ObjectId, ref: 'ProvenanceRecord' }],
    processingManifestId: String,
  },
  { _id: false },
);

export function provenancePlugin(schema: Schema): void {
  schema.add({ provenance: { type: ProvenanceSchema, required: true } });

  schema.pre('validate', function (next) {
    const p = (this as unknown as { provenance?: Record<string, unknown> }).provenance;
    if (!p) return next(new Error('provenance is required'));
    const provider = String(p.provider ?? '').trim();
    const externalId = String(p.externalId ?? '').trim();
    const licence = String(p.licence ?? '').trim();
    const datasetId = String(p.datasetId ?? '').trim();
    if (!provider || !externalId || !licence || !datasetId) {
      return next(
        new Error(
          'provenance is incomplete (provider, datasetId, externalId, licence are required)',
        ),
      );
    }
    if (!SOURCE_TYPES.includes(p.sourceType as (typeof SOURCE_TYPES)[number])) {
      return next(
        new Error(`provenance.sourceType "${String(p.sourceType)}" is not an allowed value`),
      );
    }
    next();
  });
}
