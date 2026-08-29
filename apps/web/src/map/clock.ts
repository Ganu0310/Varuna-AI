/**
 * The playback clock's one step — 05_FRONTEND §5.3.3, 04_UIUX §4.6.4.
 *
 * Extracted from the animation loop so the behaviour that matters can be tested without a
 * browser: what the cursor does when frames stop arriving.
 */

export interface ClockStep {
  cursor: number;
  playing: boolean;
  /** Multiplier: 1, 10, 60 or 300. */
  speed: number;
  windowStart: number;
  windowEnd: number;
  /** Wall-clock milliseconds since the previous frame. */
  elapsedMs: number;
  /** Whether the tab is hidden right now. */
  hidden: boolean;
}

/**
 * Longest delta the clock will integrate in one step.
 *
 * A backgrounded tab throttles or stops `requestAnimationFrame`, so the first frame after
 * returning carries the entire time away with it — seconds, or minutes. At 300x that advances
 * the cursor by hours in a single step, and the analyst comes back to a playhead somewhere
 * they did not put it. `useTimeStore.cursor` is the record of where they are in the incident;
 * it must not move while nobody is watching.
 *
 * 250 ms is about four dropped frames. Longer than that is not a slow frame, it is an
 * interruption — and an interruption should cost no incident time at all.
 */
export const MAX_FRAME_MS = 250;

/**
 * Where the cursor goes next.
 *
 * Hidden or paused, it does not move. Playback resumes by itself when the tab comes back:
 * freezing is not a pause the analyst has to undo, because they never asked for one.
 */
export function nextCursor(s: ClockStep): number {
  if (s.hidden || !s.playing) return s.cursor;

  const dt = Math.min(Math.max(s.elapsedMs, 0), MAX_FRAME_MS);
  const advanced = s.cursor + dt * s.speed;

  // Loop back to the start of the window rather than running past its end. The window is the
  // investigation's time bounds, and there is no data outside it to show.
  return advanced > s.windowEnd ? s.windowStart : advanced;
}
