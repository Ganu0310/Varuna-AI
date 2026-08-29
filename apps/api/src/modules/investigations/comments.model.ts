import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Analyst notes on an investigation — 06_BACKEND §6.4.2.
 *
 * Attribution work is a chain of judgement calls that the data does not record: why this
 * detection was dismissed as a look-alike, why the drift horizon was extended, why the
 * second-ranked vessel was worth a second look. The audit log captures what the system did;
 * this captures what a person thought, which is what the next analyst on the case actually
 * needs and what a reviewer will ask about months later.
 *
 * **Immutable, and deletable only by their author.** A comment can be retracted but not
 * quietly rewritten. An analytical note that could be edited after the fact is worthless as a
 * record of what was believed at the time, and this project's whole posture is that its
 * outputs survive being questioned. Retraction preserves the fact that something was said and
 * withdrawn, which is itself part of the record.
 *
 * Optionally anchored to an object — a detection, a candidate — so that "this is a rig, not a
 * spill" hangs off the thing it is about rather than floating at the top of the case.
 */
const CommentSchema = new Schema(
  {
    investigationId: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: true,
      index: true,
    },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Denormalised so a comment still reads correctly after the account is deactivated. */
    authorEmail: { type: String, required: true },
    body: {
      type: String,
      // Required to POST, but not once retracted — retraction clears the body and keeps the
      // row, so an unconditional `required` would make a comment impossible to withdraw.
      required: function (this: { retractedAt?: Date | null }) {
        return !this.retractedAt;
      },
      maxlength: 4000,
    },

    /**
     * What the note is about. Both fields or neither — a type with no id points at nothing,
     * and an id with no type cannot be resolved.
     */
    subjectType: {
      type: String,
      enum: ['DETECTION', 'CANDIDATE', 'ORIGIN', 'SCENE'],
      default: null,
    },
    subjectId: { type: Schema.Types.ObjectId, default: null },

    /**
     * Retraction, not deletion. The row stays so the conversation still makes sense; the body
     * is cleared so the withdrawn claim is not still sitting there being read.
     */
    retractedAt: { type: Date, default: null },
    retractedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// The read is always "this investigation's comments, newest last" — a conversation reads
// forwards. Anchored notes are filtered from that same set rather than fetched separately.
CommentSchema.index({ investigationId: 1, createdAt: 1 });
CommentSchema.index({ investigationId: 1, subjectType: 1, subjectId: 1 });

export type CommentDoc = InferSchemaType<typeof CommentSchema>;
export const CommentModel = model('Comment', CommentSchema, 'investigation_comments');
