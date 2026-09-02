import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * `/system` — the capability matrix. 14 Phase 17.
 *
 * One question answered for every stage of the chain: can this stage do its job right now,
 * and if not, what exactly is missing and what does that cost the answer?
 *
 * The `consequence` column is the one that matters and the one a conventional status page
 * omits. An operator needs to know a credential is absent; an analyst, a judge and a
 * regulator need to know what the absence does to the conclusion — that a missing wind field
 * under-displaces a wind-driven slick, or that a degraded origin caps every candidate at
 * MODERATE. Reporting only "DEGRADED" would leave everyone to guess at that, and they would
 * guess generously.
 */

interface Provider {
  name: string;
  configured: boolean;
  role: 'PRIMARY' | 'FALLBACK' | 'ENRICHMENT';
  note?: string;
}

interface Capability {
  key: string;
  label: string;
  state: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'OPTIONAL';
  reason: string;
  consequence: string;
  providers: Provider[];
}

interface CapabilityReport {
  generatedAt: string;
  overall: Capability['state'];
  capabilities: Capability[];
  note: string;
}

export function SystemStatusPage() {
  const q = useQuery({
    queryKey: ['system', 'capabilities'],
    queryFn: () => api.get<CapabilityReport>('/system/capabilities'),
    refetchInterval: 60_000,
  });

  if (q.isError) {
    return (
      <main className="page">
        <h1>System status</h1>
        <div className="panel-error" role="alert">
          <strong>Status is unavailable</strong>
          <p>
            The capability report could not be read. That is itself a finding: treat every
            capability below as unverified rather than assuming it is working.
          </p>
        </div>
      </main>
    );
  }

  const d = q.data;

  return (
    <main className="page page-wide">
      <div className="page-head">
        <div>
          <h1>System status</h1>
          <p className="muted">
            {d?.note ?? 'Configuration and recorded provider health, not a live network probe.'}
          </p>
        </div>
        {d ? (
          <span className={`status-badge status-${d.overall.toLowerCase()}`}>
            SYSTEM {d.overall}
          </span>
        ) : null}
      </div>

      <p className="muted">
        The overall state is the <strong>weakest</strong> capability, not an average. A chain is
        only as strong as its weakest link, and averaging would hide exactly the link that matters.
        {d ? <> Generated {formatUtc(d.generatedAt)}.</> : null}
      </p>

      <div className="capability-grid">
        {(d?.capabilities ?? []).map((c) => (
          <section className={`card capability status-${c.state.toLowerCase()}`} key={c.key}>
            <div className="card-head">
              <h2>{c.label}</h2>
              <span className={`token status-${c.state.toLowerCase()}`}>{c.state}</span>
            </div>

            <p className="capability-reason">{c.reason}</p>

            <div className="capability-consequence">
              <span className="label">What this costs the conclusion</span>
              <p>{c.consequence}</p>
            </div>

            <ul className="provider-list">
              {c.providers.map((p) => (
                <li key={p.name}>
                  <span className={p.configured ? 'token status-available' : 'token'}>
                    {p.configured ? 'configured' : 'not configured'}
                  </span>
                  <span className="provider-name">{p.name}</span>
                  <span className="muted provider-role">{p.role.toLowerCase()}</span>
                  {p.note ? <div className="muted provider-note">{p.note}</div> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
