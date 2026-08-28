import type { ReactNode } from 'react';

/**
 * The shell around `/login` and `/register` — 04_UIUX §4.5, 05_FRONTEND §5.5.1.
 *
 * The sign-in screen is the first thing anyone sees, and a bare form on a black field says
 * nothing about what they are about to use. The left panel states what the system does and,
 * more importantly, what it refuses to do.
 *
 * Every claim here is one the build actually enforces, not marketing copy: the provenance
 * guard strips unsourced objects from responses, the tier cap is applied when the origin is
 * degraded, and unmeasured features are rendered hatched rather than omitted. If any of these
 * stops being true, this text has to change with it.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-brand" aria-labelledby="brand-title">
        <p className="auth-eyebrow mono">SIH26143</p>
        <h1 id="brand-title" className="auth-wordmark">
          VARUNA
        </h1>
        <p className="auth-tagline">
          Attributing marine oil spills to vessels, from satellite radar and AIS.
        </p>

        <dl className="auth-principles">
          <div>
            <dt>Real data only</dt>
            <dd>
              Every figure traces back to a provider product an evaluator can retrieve. Nothing is
              simulated, and an object without provenance is removed rather than shown.
            </dd>
          </div>
          <div>
            <dt>Leads, not verdicts</dt>
            <dd>
              Candidates are ranked as investigative leads. A score is weighted evidence, not a
              probability, and the system says so wherever a score appears.
            </dd>
          </div>
          <div>
            <dt>Stated limits</dt>
            <dd>
              Evidence that could not be measured is shown as unmeasured, never quietly dropped.
              When the analysis is degraded, the ranking is capped and the reason is given.
            </dd>
          </div>
        </dl>
      </section>

      <section className="auth-form-side">{children}</section>
    </main>
  );
}
