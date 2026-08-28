import { useEffect } from 'react';
import { useTimeStore, timeChannel } from '../state/stores.ts';
import { formatUtc } from '../lib/format.ts';

/**
 * Time scrubber — 04_UIUX §4.7.4.
 *
 * The release window is drawn as a BAND, never a line. That is the whole point: the release
 * time is an interval with a most-likely sub-interval, and a single tick mark would assert a
 * precision the drift model cannot support. The band is the honest rendering of the same
 * number the report prints.
 *
 * Playback drives `timeChannel` at frame rate; this component reads the React store, which
 * is synced at 4 Hz, because a clock updating four times a second is indistinguishable from
 * one updating sixty times — and the difference in re-renders is the frame budget.
 */
interface Props {
  releaseWindow?: {
    earliest: string;
    latest: string;
    mostLikelyStart: string;
    mostLikelyEnd: string;
    status: 'OK' | 'WIDE';
  } | null;
  /** Acquisition times, drawn as ticks so a scene boundary is visible while scrubbing. */
  sceneTimes?: string[];
}

const SPEEDS = [1, 10, 60, 300] as const;

export function TimeScrubber({ releaseWindow, sceneTimes = [] }: Props) {
  const { cursor, windowStart, windowEnd, playing, speed, setCursor, play, pause, setSpeed, step } =
    useTimeStore();

  const span = Math.max(1, windowEnd - windowStart);
  const pct = (ms: number) => ((ms - windowStart) / span) * 100;

  // Keyboard stepping: arrows move by minutes, shift-arrows by an hour (04_UIUX §4.7.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (playing) pause();
        else play();
      } else if (e.key === 'ArrowLeft') {
        step(e.shiftKey ? -3_600_000 : -60_000);
      } else if (e.key === 'ArrowRight') {
        step(e.shiftKey ? 3_600_000 : 60_000);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, pause, step]);

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  return (
    <div className="scrubber" role="group" aria-label="Time controls">
      <div className="scrubber-controls">
        <button
          onClick={() => (playing ? pause() : play())}
          aria-label={playing ? 'Pause playback' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        {/* Under reduced motion, playback is replaced by explicit stepping so no information
            is lost — the data animation becomes a control, not a removal (04_UIUX §4.5). */}
        {reducedMotion ? (
          <>
            <button onClick={() => step(-3_600_000)} aria-label="Step back one hour">
              −1 h
            </button>
            <button onClick={() => step(3_600_000)} aria-label="Step forward one hour">
              +1 h
            </button>
          </>
        ) : (
          <div className="speeds" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={s === speed ? 'speed on' : 'speed'}
                onClick={() => setSpeed(s)}
                aria-pressed={s === speed}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
        <span className="mono cursor-time" aria-live="off">
          {formatUtc(new Date(cursor))}
        </span>
      </div>

      <div className="scrubber-track">
        {/* The release window as a band, with a darker most-likely core. */}
        {releaseWindow ? (
          <>
            <div
              className={`release-band ${releaseWindow.status === 'WIDE' ? 'wide' : ''}`}
              style={{
                left: `${pct(Date.parse(releaseWindow.earliest))}%`,
                width: `${pct(Date.parse(releaseWindow.latest)) - pct(Date.parse(releaseWindow.earliest))}%`,
              }}
              title={`Release window ${formatUtc(releaseWindow.earliest)} → ${formatUtc(releaseWindow.latest)}${
                releaseWindow.status === 'WIDE' ? ' (WIDE — drift too slow to date the slick)' : ''
              }`}
            />
            <div
              className="release-band-core"
              style={{
                left: `${pct(Date.parse(releaseWindow.mostLikelyStart))}%`,
                width: `${pct(Date.parse(releaseWindow.mostLikelyEnd)) - pct(Date.parse(releaseWindow.mostLikelyStart))}%`,
              }}
              title="Most likely release interval"
            />
          </>
        ) : null}

        {sceneTimes.map((t) => (
          <div
            key={t}
            className="scene-tick"
            style={{ left: `${pct(Date.parse(t))}%` }}
            title={`Acquisition ${formatUtc(t)}`}
          />
        ))}

        <input
          type="range"
          min={windowStart}
          max={windowEnd}
          value={cursor}
          onChange={(e) => {
            const v = Number(e.target.value);
            setCursor(v);
            timeChannel.cursor = v;
          }}
          aria-label="Time cursor"
          aria-valuetext={formatUtc(new Date(cursor))}
        />
      </div>

      <div className="scrubber-ends mono muted">
        <span>{formatUtc(new Date(windowStart))}</span>
        <span>{formatUtc(new Date(windowEnd))}</span>
      </div>

      {releaseWindow?.status === 'WIDE' ? (
        <p className="field-hint">
          The release window is WIDE: drift was too slow to infer the slick&rsquo;s age from its
          length, so the band spans the whole back-tracking horizon rather than a narrower estimate.
        </p>
      ) : null}
    </div>
  );
}
