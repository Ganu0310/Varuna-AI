import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One row per Discover watch region — 06_BACKEND §6.4.10.
 *
 * Deliberately NOT fields on `Investigation` itself: a sweep container is a real
 * investigation document by design (so the unmodified ingest pipeline can write scenes and
 * detections into it), and this is the internal bookkeeping the container doesn't need to
 * carry — which region it stands for, and how far the sweep has already searched. Keeping it
 * separate means `Investigation` stays exactly what it always was for every other reader.
 */
const SweepStateSchema = new Schema(
  {
    /** Matches a `WatchRegion.id` from `@varuna/shared`. */
    regionId: { type: String, required: true, unique: true },
    containerInvestigationId: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: true,
    },
    /**
     * Null until the first tick. A tick only searches the catalogue for scenes newer than
     * this, so the rolling window shrinks to "since last time" instead of re-querying the
     * same days on every run.
     */
    lastSweptAt: { type: Date, default: null },
    /**
     * What the last tick actually saw — kept so Discover can tell the two silences apart.
     *
     * "No overpasses at all" and "overpasses existed but none in a form this pipeline can
     * read" look identical on an empty map, and they mean opposite things: the first is a
     * quiet ocean, the second is a coverage problem the operator needs to know about. Without
     * this, the UI can only say "nothing found", which is the more reassuring of the two and
     * wrong exactly when it matters.
     */
    lastResult: {
      overpassesSeen: { type: Number, default: null },
      ingestible: { type: Number, default: null },
      enqueued: { type: Number, default: null },
      error: { type: String, default: null },
    },
  },
  { timestamps: true, collection: 'sweep_states' },
);

export type SweepState = InferSchemaType<typeof SweepStateSchema>;
export const SweepStateModel = model('SweepState', SweepStateSchema);

/**
 * Every acquisition a sweep saw over a watch region — readable or not.
 *
 * The sweep used to keep only the ingestible results and discard the rest, which threw away
 * the most useful thing it knows: a satellite DID look here, on these dates, and this is why
 * the product cannot be analysed. With only counts retained, Discover could say "144
 * overpasses, 0 readable" but could not show which, when, or where.
 *
 * A cached catalogue listing rather than an ingested observation, so it carries its source as
 * plain fields instead of the provenance plugin — but it carries all of them: `provider` and
 * `collection` are the dataset it came from, `productId` is the identifier an evaluator can
 * look up at that provider, and `seenAt` is when we asked. Nothing here is derived or
 * inferred; every field is what the provider returned.
 */
const SweepOverpassSchema = new Schema(
  {
    /** Matches a `WatchRegion.id` from `@varuna/shared`. */
    regionId: { type: String, required: true, index: true },
    /** The provider's own product identifier — the field an evaluator can look up. */
    productId: { type: String, required: true },
    provider: { type: String, required: true },
    /**
     * The STAC collection the product belongs to. NOT named `collection`: that is a reserved
     * Mongoose document path (`doc.collection` is the model's own collection handle), and
     * Mongoose warns at boot that using it "may break some functionality". Exposed to API
     * consumers as `collection` regardless — see `listOverpasses`.
     */
    stacCollection: { type: String, required: true },
    /** UTC, from provider metadata only — never inferred. */
    acquiredAt: { type: Date, required: true, index: true },
    platform: { type: String, default: null },
    footprint: { type: Schema.Types.Mixed, default: null },
    /**
     * Whether THIS pipeline can read the product, as decided once by `decideIngestible`
     * (`../../providers/chain.ts`) — stored rather than re-derived, so the browse view and
     * the sweep that found it can never disagree about why something was skipped.
     */
    ingestible: { type: Boolean, required: true },
    ingestibleReason: { type: String, default: null },
    /** When the sweep last saw this listed. Not the acquisition time. */
    seenAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'sweep_overpasses' },
);

// One row per acquisition per region: a repeat tick re-sees the same products and must update
// them, not accumulate duplicates.
SweepOverpassSchema.index({ regionId: 1, productId: 1 }, { unique: true });

export type SweepOverpass = InferSchemaType<typeof SweepOverpassSchema>;
export const SweepOverpassModel = model('SweepOverpass', SweepOverpassSchema);
