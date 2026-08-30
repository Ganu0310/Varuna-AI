import { describe, it, expect } from 'vitest';
import { classify, summarise, MIN_LABELS_PER_CLASS, type ReviewedDetection } from './labels.js';

/**
 * The rule that decides what may be trained on — 07_AIML §7.2.12.
 *
 * This is the one place in the training path where a wrong answer is invisible: a bad label
 * does not throw, it just quietly makes the next model worse, and the eval that would catch
 * it runs weeks later. So the rule is a pure function and it is tested directly.
 */

const BASE: ReviewedDetection = {
  detectionId: 'd1',
  investigationId: 'i1',
  sceneId: 's1',
  productId: 'S1C_IW_GRDH_1SDV_20250921T200737',
  acquiredAt: '2025-09-21T20:07:48.000Z',
  geometry: { type: 'Polygon', coordinates: [] },
  areaKm2: 4.9,
  reviewStatus: 'REJECTED',
  edited: false,
  reviewedAt: '2025-09-22T09:00:00.000Z',
  reviewedBy: 'u1',
  note: 'Glassy patch in the lee of the headland.',
  rejectionCategory: 'LOW_WIND',
  detector: { name: 'classical-darkspot', version: '1.0.0', artefactSha256: 'ed1867ad' },
  lookAlikeRisk: 0.26,
  provenance: { sourceType: 'DERIVED' },
};

const at = (o: Partial<ReviewedDetection>): ReviewedDetection => ({ ...BASE, ...o });

describe('what counts as a training label', () => {
  it('a confirmed detection is a positive oil sample', () => {
    const l = classify(at({ reviewStatus: 'CONFIRMED', rejectionCategory: null }));
    expect(l).toMatchObject({ polarity: 'POSITIVE', sarClass: 'oil_spill' });
  });

  it('a look-alike rejection is a negative of the class the analyst named', () => {
    expect(classify(at({ rejectionCategory: 'LOW_WIND' }))).toMatchObject({
      polarity: 'NEGATIVE',
      sarClass: 'sea_surface',
    });
    expect(classify(at({ rejectionCategory: 'RAIN_CELL' }))).toMatchObject({
      polarity: 'NEGATIVE',
      sarClass: 'look_alike',
    });
    // A hole in the coastline mask is a land sample, not a look-alike one — and knowing
    // which is what makes the mask fixable rather than just the model retrainable.
    expect(classify(at({ rejectionCategory: 'LAND_OR_STRUCTURE' }))).toMatchObject({
      polarity: 'NEGATIVE',
      sarClass: 'land',
    });
  });

  it('an OPERATIONAL rejection is never a negative, however emphatic the note', () => {
    for (const c of ['DUPLICATE', 'SUPERSEDED', 'OUT_OF_SCOPE', 'INSUFFICIENT_IMAGE_QUALITY']) {
      const r = classify(at({ rejectionCategory: c as ReviewedDetection['rejectionCategory'] }));
      expect(r).not.toHaveProperty('polarity');
      expect(r).toHaveProperty('reason');
    }
    // The reason says WHY, so a reader of the export is not left guessing.
    expect(classify(at({ rejectionCategory: 'DUPLICATE' }))).toMatchObject({
      reason: expect.stringContaining('says nothing about the'),
    });
  });

  it('a sensor artefact is not oil and is still not a training sample', () => {
    // It is a LOOK_ALIKE by kind — the analyst genuinely judged it not to be oil — but the
    // pixels are not a valid instance of any physical class, so it names no sarClass.
    const r = classify(at({ rejectionCategory: 'SENSOR_ARTEFACT' }));
    expect(r).not.toHaveProperty('polarity');
    expect(r).toMatchObject({ reason: expect.stringContaining('not a valid sample') });
  });

  it('a rejection recorded before the taxonomy is UNCATEGORISED, never guessed', () => {
    const r = classify(at({ rejectionCategory: null }));
    expect(r).not.toHaveProperty('polarity');
    expect(r).toMatchObject({ reason: expect.stringContaining('not back-filled') });
  });

  it('an unreviewed detection carries no human judgement and is excluded', () => {
    const r = classify(at({ reviewStatus: 'UNREVIEWED', rejectionCategory: null }));
    expect(r).not.toHaveProperty('polarity');
  });

  it('an edited outline is marked as the analyst’s, not the model’s', () => {
    expect(
      classify(at({ reviewStatus: 'EDITED', edited: true, rejectionCategory: null })),
    ).toMatchObject({ polarity: 'POSITIVE', geometrySource: 'ANALYST' });
    expect(
      classify(at({ reviewStatus: 'CONFIRMED', edited: false, rejectionCategory: null })),
    ).toMatchObject({ geometrySource: 'MODEL' });
  });
});

describe('the summary an operator decides to retrain on', () => {
  it('counts usable labels by class and keeps the unusable ones visible', () => {
    const s = summarise([
      classify(at({ detectionId: 'a', reviewStatus: 'CONFIRMED', rejectionCategory: null })),
      classify(at({ detectionId: 'b', rejectionCategory: 'LOW_WIND' })),
      classify(at({ detectionId: 'c', rejectionCategory: 'LOW_WIND' })),
      classify(at({ detectionId: 'd', rejectionCategory: 'DUPLICATE' })),
      classify(at({ detectionId: 'e', rejectionCategory: null })),
    ]);

    expect(s.reviewedDetections).toBe(5);
    expect(s.usable).toBe(3);
    expect(s.byClass).toEqual({ oil_spill: 1, sea_surface: 2 });
    expect(s.byCategory).toEqual({ CONFIRMED_OIL: 1, LOW_WIND: 2 });
    // Dropped from the training set, NOT from the count — a set that quietly shed 40% of
    // its input would misrepresent how much review work had been done.
    expect(s.unusable.count).toBe(2);
    expect(Object.values(s.unusable.byReason).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('reports the shortfall per class rather than a bare "not ready"', () => {
    const s = summarise([classify(at({ rejectionCategory: 'LOW_WIND' }))]);
    expect(s.readyToRetrain).toBe(false);
    expect(s.shortfall).toEqual([
      { sarClass: 'sea_surface', held: 1, needed: MIN_LABELS_PER_CLASS - 1 },
    ]);
    expect(s.assessment).toContain('not yet enough to retrain');
  });

  it('does not claim readiness on a single class, however many samples it holds', () => {
    const many = Array.from({ length: MIN_LABELS_PER_CLASS + 5 }, (_, i) =>
      classify(at({ detectionId: `x${i}`, rejectionCategory: 'RAIN_CELL' })),
    );
    const s = summarise(many);
    expect(s.shortfall).toEqual([]);
    // No positives at all: a detector trained on negatives alone would learn to find
    // nothing, and would score extremely well on the look-alike half of the split doing it.
    expect(s.readyToRetrain).toBe(false);
  });

  it('says so plainly when nothing has been labelled yet', () => {
    const s = summarise([]);
    expect(s.usable).toBe(0);
    expect(s.readyToRetrain).toBe(false);
    expect(s.assessment).toContain('fills as analysts work');
  });
});
