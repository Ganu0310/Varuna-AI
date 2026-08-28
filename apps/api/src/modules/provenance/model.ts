import { Schema, model, type InferSchemaType } from 'mongoose';
import { SOURCE_TYPES } from '@varuna/shared';

/**
 * `provenance_records` — immutable. Every observed/derived document's embedded `provenance`
 * sub-document references one of these by id, forming the lineage DAG
 * (13_REAL_DATA_POLICY §13.5.1). Writes are append-only at the application layer.
 */
const ProvenanceRecordSchema = new Schema(
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
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'provenance_records' },
);

ProvenanceRecordSchema.index({ externalId: 1 });
ProvenanceRecordSchema.index({ sourceType: 1, retrievedAt: -1 });

// Immutability: block updates/deletes at the model layer.
for (const op of [
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const) {
  ProvenanceRecordSchema.pre(op, function (next) {
    next(new Error('provenance_records are immutable'));
  });
}

export type ProvenanceRecord = InferSchemaType<typeof ProvenanceRecordSchema>;
export const ProvenanceRecordModel = model('ProvenanceRecord', ProvenanceRecordSchema);
