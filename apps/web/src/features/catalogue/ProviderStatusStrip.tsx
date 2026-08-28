import type { ProviderStatus } from '../../api/hooks.ts';

/**
 * Per-provider outcome strip — 06_BACKEND §6.4.3.
 *
 * A partial failure must be VISIBLE, not silently reflected as a shorter list. This is also
 * where the difference between "this provider found nothing" (a real answer about coverage)
 * and "this provider could not be reached" is shown to the analyst.
 */
const LABEL: Record<ProviderStatus['status'], string> = {
  OK: 'OK',
  NO_RESULTS: 'NO RESULTS',
  CIRCUIT_OPEN: 'CIRCUIT OPEN',
  QUOTA_EXHAUSTED: 'QUOTA EXHAUSTED',
  NOT_CONFIGURED: 'NOT CONFIGURED',
  TIMEOUT: 'UNREACHABLE',
  ERROR: 'ERROR',
};

const TONE: Record<ProviderStatus['status'], string> = {
  OK: 'token-ok',
  NO_RESULTS: '',
  CIRCUIT_OPEN: 'token-warn',
  QUOTA_EXHAUSTED: 'token-warn',
  NOT_CONFIGURED: '',
  TIMEOUT: 'token-danger',
  ERROR: 'token-danger',
};

export function ProviderStatusStrip({ statuses }: { statuses: ProviderStatus[] }) {
  return (
    <div className="provider-strip" aria-label="Provider status">
      {statuses.map((s) => (
        <div key={s.provider} className="provider-chip" title={s.reason ?? undefined}>
          <span className="mono">{s.provider}</span>
          <span className={`token ${TONE[s.status]}`}>{LABEL[s.status]}</span>
          <span className="muted mono">
            {s.count} {s.count === 1 ? 'scene' : 'scenes'}
            {s.latencyMs != null ? ` · ${s.latencyMs} ms` : ''}
          </span>
          {s.reason ? <span className="provider-reason muted">{s.reason}</span> : null}
        </div>
      ))}
    </div>
  );
}
