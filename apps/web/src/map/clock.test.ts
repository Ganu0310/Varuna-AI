import { describe, it, expect } from 'vitest';
import { nextCursor, MAX_FRAME_MS, type ClockStep } from './clock.ts';

const WINDOW_START = Date.UTC(2025, 8, 21, 0, 0, 0);
const WINDOW_END = Date.UTC(2025, 8, 22, 0, 0, 0);

const step = (over: Partial<ClockStep> = {}): ClockStep => ({
  cursor: WINDOW_START,
  playing: true,
  speed: 1,
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  elapsedMs: 16,
  hidden: false,
  ...over,
});

describe('playback clock', () => {
  it('advances by elapsed time times the speed', () => {
    expect(nextCursor(step({ elapsedMs: 100, speed: 60 }))).toBe(WINDOW_START + 6000);
  });

  it('does not move while paused', () => {
    expect(nextCursor(step({ playing: false, elapsedMs: 5000 }))).toBe(WINDOW_START);
  });

  it('loops back to the start of the window rather than running past its end', () => {
    const near = WINDOW_END - 10;
    expect(nextCursor(step({ cursor: near, elapsedMs: 100, speed: 60 }))).toBe(WINDOW_START);
  });

  describe('a hidden tab', () => {
    it('freezes the cursor', () => {
      // The analyst switched to another tab. When they come back the playhead must be where
      // they left it, not wherever the wall clock ran to.
      expect(nextCursor(step({ hidden: true, elapsedMs: 120_000, speed: 300 }))).toBe(WINDOW_START);
    });

    it('costs no incident time even at the highest speed', () => {
      const twoMinutesAway = step({ hidden: true, elapsedMs: 120_000, speed: 300 });
      // Unclamped this would advance 10 hours — past the end of the window, so the cursor
      // would have wrapped and the analyst would return to the START of the incident.
      expect(nextCursor(twoMinutesAway)).not.toBe(WINDOW_START + 120_000 * 300);
      expect(nextCursor(twoMinutesAway)).toBe(WINDOW_START);
    });
  });

  describe('a delta larger than a frame', () => {
    it('is clamped, so a stalled tab cannot leap the playhead', () => {
      // This is the case the clamp exists for: the tab was hidden, `hidden` has already
      // flipped back to false, and the FIRST frame after returning carries the whole gap.
      const resumed = step({ elapsedMs: 60_000, speed: 300 });
      expect(nextCursor(resumed)).toBe(WINDOW_START + MAX_FRAME_MS * 300);
    });

    it('still advances normally for an ordinary slow frame', () => {
      // 50 ms is a janky frame, not an interruption. It must not be treated as one.
      expect(nextCursor(step({ elapsedMs: 50, speed: 10 }))).toBe(WINDOW_START + 500);
    });
  });

  it('ignores a negative delta', () => {
    // `performance.now()` is monotonic, but the subtraction is not if the two readings come
    // from different frames after a resume. Going backwards would be worse than standing still.
    expect(nextCursor(step({ elapsedMs: -1000, speed: 60 }))).toBe(WINDOW_START);
  });
});
