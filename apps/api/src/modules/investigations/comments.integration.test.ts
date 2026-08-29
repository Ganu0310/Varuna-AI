import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { CommentModel } from './comments.model.js';
import { InvestigationModel } from './model.js';
import * as service from './service.js';

/**
 * Comments are a record of what an analyst believed at a moment. The tests that matter are
 * therefore about what CANNOT happen to that record, not about the happy path.
 */

const URI = process.env.MONGODB_URI_TEST ?? 'mongodb://localhost:27017';
const DB = 'VARUNA_TEST_COMMENTS';

const AUTHOR = {
  id: new Types.ObjectId().toString(),
  email: 'author@varuna.test',
  role: 'lead' as const,
};
const OTHER = {
  id: new Types.ObjectId().toString(),
  email: 'lead@varuna.test',
  role: 'lead' as const,
};

let investigationId: string;

describe('investigation comments', () => {
  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: DB });
  }, 30_000);

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await CommentModel.deleteMany({});
    await InvestigationModel.deleteMany({});
    // Created through the service, not the model: `aoiAreaKm2` is derived on the way in, and
    // a hand-built document skips that and fails validation.
    const inv = await service.createInvestigation(
      {
        name: 'Comment fixture',
        aoi: {
          type: 'Polygon',
          coordinates: [
            [
              [144.6, 13.4],
              [144.8, 13.4],
              [144.8, 13.6],
              [144.6, 13.6],
              [144.6, 13.4],
            ],
          ],
        },
        windowStart: '2025-09-21T00:00:00Z',
        windowEnd: '2025-09-22T00:00:00Z',
      },
      AUTHOR,
    );
    investigationId = String(inv._id);
  });

  it('records the author email on the row, not a reference to it', async () => {
    // Denormalised on purpose: a note must keep reading correctly after the account is
    // deactivated or renamed, and a join to a live user record would let a later change
    // rewrite the attribution on an old statement.
    const doc = await service.addComment(investigationId, { body: 'Looks biogenic' }, AUTHOR);
    expect(doc.authorEmail).toBe('author@varuna.test');
  });

  it('reads forwards — a conversation is oldest first', async () => {
    await service.addComment(investigationId, { body: 'first' }, AUTHOR);
    await service.addComment(investigationId, { body: 'second' }, OTHER);
    const items = await service.listComments(investigationId);
    expect(items.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('filters to one anchored object', async () => {
    const detection = new Types.ObjectId().toString();
    await service.addComment(investigationId, { body: 'case level' }, AUTHOR);
    await service.addComment(
      investigationId,
      { body: 'this one is a rig', subjectType: 'DETECTION', subjectId: detection },
      AUTHOR,
    );

    const anchored = await service.listComments(investigationId, {
      type: 'DETECTION',
      id: detection,
    });
    expect(anchored.map((c) => c.body)).toEqual(['this one is a rig']);
  });

  describe('retraction', () => {
    it('is refused for anyone but the author — including a lead', async () => {
      // A lead removing someone else's note would make the thread a record of what the lead
      // was willing to leave standing, which is a different and far less useful thing.
      const doc = await service.addComment(investigationId, { body: 'I disagree' }, AUTHOR);
      await expect(service.retractComment(investigationId, String(doc._id), OTHER)).rejects.toThrow(
        /only be retracted by the analyst who wrote it/,
      );

      const still = await CommentModel.findById(doc._id);
      expect(still?.body).toBe('I disagree');
    });

    it('clears the body but keeps the row', async () => {
      // Deleting outright would leave replies answering nothing, and would hide that a claim
      // was made and withdrawn — itself part of the record.
      const doc = await service.addComment(investigationId, { body: 'wrong call' }, AUTHOR);
      await service.retractComment(investigationId, String(doc._id), AUTHOR);

      const items = await service.listComments(investigationId);
      expect(items).toHaveLength(1);
      expect(items[0]!.body).toBe('');
      expect(items[0]!.retractedAt).toBeInstanceOf(Date);
      expect(String(items[0]!.retractedBy)).toBe(AUTHOR.id);
    });

    it('is idempotent', async () => {
      const doc = await service.addComment(investigationId, { body: 'x' }, AUTHOR);
      const first = await service.retractComment(investigationId, String(doc._id), AUTHOR);
      const second = await service.retractComment(investigationId, String(doc._id), AUTHOR);
      expect(second.retractedAt?.getTime()).toBe(first.retractedAt?.getTime());
    });

    it('will not reach a comment on a different investigation', async () => {
      const other = await service.createInvestigation(
        {
          name: 'Elsewhere',
          aoi: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
          windowStart: '2025-09-21T00:00:00Z',
          windowEnd: '2025-09-22T00:00:00Z',
        },
        AUTHOR,
      );
      const doc = await service.addComment(String(other._id), { body: 'theirs' }, AUTHOR);

      await expect(
        service.retractComment(investigationId, String(doc._id), AUTHOR),
      ).rejects.toThrow(/No such comment/);
    });
  });

  it('the model has no update path — a note cannot be silently rewritten', async () => {
    // `updatedAt` is deliberately absent from the schema's timestamps. If it appears, someone
    // has added a mutation path and this record is no longer evidence of anything.
    const doc = await service.addComment(investigationId, { body: 'as recorded' }, AUTHOR);
    const raw = await CommentModel.findById(doc._id).lean();
    expect(raw).not.toHaveProperty('updatedAt');
  });
});
