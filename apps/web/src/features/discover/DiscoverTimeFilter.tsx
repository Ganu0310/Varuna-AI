import { useEffect, useState } from 'react';

/**
 * Discover's time-period control — deliberately NOT `TimeScrubber`.
 *
 * `TimeScrubber` (`apps/web/src/components/TimeScrubber.tsx`) is a playback cursor: it reads
 * and writes a single moving instant from the global time store, built for scrubbing through
 * one investigation's own scene sequence. Discover has no cursor to scrub — it has a period
 * to browse — so it needs the plainer control a period actually calls for: a few common
 * presets, or a custom range, each producing a `[from, to]` pair and nothing else.
 */

export type PeriodPreset = '24h' | '7d' | '30d' | 'custom';

export interface Period {
  from: string;
  to: string;
}

function presetToPeriod(preset: Exclude<PeriodPreset, 'custom'>): Period {
  const days = preset === '24h' ? 1 : preset === '7d' ? 7 : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The same two rules the API enforces (`DiscoverDetectionsQuery`), checked here so a
 * half-typed date never becomes a request.
 *
 * A `datetime-local` input fires on every keystroke, so typing a year produces `0002-…`,
 * `0020-…`, `0202-…` on the way to `2026-…`. Reporting each of those upward sent a doomed
 * query per keystroke — the console filled with 400s, and the one real mistake a user could
 * make was invisible among them. Now the period simply does not update until it is valid,
 * and the reason is shown instead.
 */
function invalidReason(p: Period): string | null {
  const from = Date.parse(p.from);
  const to = Date.parse(p.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'Enter a complete start and end date.';
  if (to <= from) return 'The end must be after the start.';
  if ((to - from) / 86_400_000 > 90) return 'The period must not exceed 90 days.';
  return null;
}

/** `datetime-local`'s own format, read as UTC like every other timestamp in this app. */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}
function fromLocalInput(local: string): string {
  return new Date(`${local}:00Z`).toISOString();
}

export function DiscoverTimeFilter({
  onChange,
  override,
}: {
  onChange: (period: Period) => void;
  /**
   * A period chosen elsewhere on the page — the empty state's "show me those" button, which
   * widens to the window where results actually exist.
   *
   * The control stays uncontrolled otherwise. Making it fully controlled would push a
   * half-typed date into the parent on every keystroke, which is exactly the behaviour
   * `invalidReason` exists to prevent; this narrower door lets one deliberate jump in without
   * reopening that.
   */
  override?: Period | null;
}) {
  const [preset, setPreset] = useState<PeriodPreset>('7d');
  const [custom, setCustom] = useState<Period>(() => presetToPeriod('7d'));

  // Reported once on mount, so the caller has a real period to query from the first render
  // rather than waiting for the analyst to press a button that only re-selects the default.
  // Safe with `custom` and `onChange` omitted from the trigger: `custom`'s initial value
  // never changes without a re-render this effect would also see, and the caller
  // (`DiscoverPage`) passes `setPeriod` — a `useState` setter, referentially stable for the
  // life of the component — so this genuinely fires once.
  useEffect(() => onChange(custom), [onChange]);

  // A jump requested from outside. Switches to the custom preset so the dates it lands on are
  // visible and editable, rather than silently disagreeing with a highlighted preset button.
  useEffect(() => {
    if (!override) return;
    setPreset('custom');
    setCustom(override);
    onChange(override);
  }, [override, onChange]);

  function choose(next: PeriodPreset) {
    setPreset(next);
    if (next !== 'custom') {
      const period = presetToPeriod(next);
      setCustom(period);
      onChange(period);
    }
  }

  return (
    <div className="discover-time-filter">
      <div className="discover-time-presets" role="group" aria-label="Time period">
        {(
          [
            ['24h', 'Last 24 hours'],
            ['7d', 'Last 7 days'],
            ['30d', 'Last 30 days'],
            ['custom', 'Custom'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={preset === key ? 'discover-preset on' : 'discover-preset'}
            aria-pressed={preset === key}
            onClick={() => choose(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {preset === 'custom' ? (
        <div className="discover-time-custom">
          <label className="sr-only" htmlFor="discover-from">
            From (UTC)
          </label>
          <input
            id="discover-from"
            type="datetime-local"
            value={toLocalInput(custom.from)}
            onChange={(e) => {
              const next = { ...custom, from: fromLocalInput(e.target.value) };
              setCustom(next);
              if (!invalidReason(next)) onChange(next);
            }}
          />
          <span aria-hidden="true">→</span>
          <label className="sr-only" htmlFor="discover-to">
            To (UTC)
          </label>
          <input
            id="discover-to"
            type="datetime-local"
            value={toLocalInput(custom.to)}
            onChange={(e) => {
              const next = { ...custom, to: fromLocalInput(e.target.value) };
              setCustom(next);
              if (!invalidReason(next)) onChange(next);
            }}
          />
        </div>
      ) : null}

      {/* Silence would be worse than the 400s were: without this, typing an end date before
          the start simply stops updating the results with no explanation. */}
      {preset === 'custom' && invalidReason(custom) ? (
        <p className="field-error" role="alert">
          {invalidReason(custom)} Showing the last valid period.
        </p>
      ) : null}
    </div>
  );
}
