import { useProviderHealth } from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Circuit state, quota consumption and p95 latency per provider
 * (06_BACKEND §6.4.10, 02_TRD §2.12).
 *
 * This reports the truth — including "not configured" and a quota already spent — rather
 * than green ticks. Discovering a quota ceiling mid-demonstration is the failure mode this
 * panel exists to prevent (11_API_KEYS §11.8).
 */
export function ProviderHealthTable() {
  const { data, isLoading, isError } = useProviderHealth();

  if (isLoading) return <p className="muted">Loading provider health…</p>;
  if (isError) return <p className="field-error">Could not load provider health.</p>;

  const items = data?.items ?? [];

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Configured</th>
          <th>Circuit</th>
          <th className="num">Calls</th>
          <th className="num">Failures</th>
          <th className="num">p95</th>
          <th>Quota</th>
          <th>Last success</th>
        </tr>
      </thead>
      <tbody>
        {items.map((p) => (
          <tr key={p.provider}>
            <td className="mono">{p.provider}</td>
            <td>
              <span className={`token ${p.configured ? 'token-ok' : ''}`}>
                {p.configured ? 'YES' : 'NO CREDENTIALS'}
              </span>
            </td>
            <td>
              <span className={`token ${p.circuit.state === 'CLOSED' ? 'token-ok' : 'token-warn'}`}>
                {p.circuit.state}
              </span>
              {p.circuit.retryAt ? (
                <span className="muted mono"> retry {formatUtc(p.circuit.retryAt)}</span>
              ) : null}
            </td>
            <td className="num mono">{p.calls}</td>
            <td className="num mono">{p.failures}</td>
            <td className="num mono">{p.p95LatencyMs == null ? '—' : `${p.p95LatencyMs} ms`}</td>
            <td className="mono">
              {p.quotas.length === 0
                ? '—'
                : p.quotas.map((q) => (
                    <div key={q.quotaKey}>
                      {q.quotaKey.split(':')[1]}: {q.used}
                      {q.limit != null ? `/${q.limit}` : ''}
                    </div>
                  ))}
            </td>
            <td className="mono">
              {p.circuit.lastSuccessAt ? formatUtc(p.circuit.lastSuccessAt) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
