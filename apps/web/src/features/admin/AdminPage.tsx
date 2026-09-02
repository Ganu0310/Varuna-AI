import { useState } from 'react';
import { CircuitState } from '../../components/CircuitState.tsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * `/admin` — 06_BACKEND §6.4.10.
 *
 * Users and roles, live provider health, quota consumption, every investigation on the
 * instance, the rendered dossiers, and the audit log. Every one of these endpoints existed
 * with no route to reach it.
 *
 * The investigation and dossier tables are here rather than in the analyst workspace because
 * they answer an operator's question, not an analyst's: not "which case shall I open?" but
 * "which cases are stuck, which have lost their owner, and which dossiers no longer belong
 * to a case at all?"
 *
 * The audit log is read-only here by design. It is append-only server-side and there is
 * deliberately no delete: a log an administrator can edit is not evidence of anything.
 */

interface AdminUser {
  _id: string;
  email: string;
  name: string;
  role: 'viewer' | 'analyst' | 'lead' | 'admin';
  lastLoginAt: string | null;
}

interface ProviderHealth {
  provider: string;
  circuit: { state: string; consecutiveFailures: number; retryAt: string | null };
  calls: number;
  failures: number;
  p95LatencyMs: number | null;
  configured: boolean;
  quotas: QuotaSnapshot[];
}

interface QuotaSnapshot {
  quotaKey: string;
  used: number | null;
  limit: number | null;
  period: string | null;
  resetAt: string | null;
}

interface AuditEntry {
  _id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  at: string;
  requestId: string | null;
}

interface AdminInvestigation {
  _id: string;
  name: string | null;
  status: string | null;
  createdAt: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  ownerMissing: boolean;
  memberCount: number;
  counts: {
    scenes: number;
    detections: number;
    origins: number;
    candidates: number;
    reports: number;
  };
}

interface RenderedReport {
  filename: string;
  investigationId: string;
  renderedAt: string | null;
  sizeBytes: number;
  investigationExists: boolean;
  orphaned: boolean;
}

const ROLES = ['viewer', 'analyst', 'lead', 'admin'] as const;

/**
 * Where a case stopped, from its per-stage counts.
 *
 * The status field alone cannot answer this: `IN_PROGRESS` covers both a case waiting on an
 * analyst and one whose ingest died three stages ago. The counts can, because each stage
 * only produces rows once the previous one has.
 */
function stalledAt(c: AdminInvestigation['counts']): string {
  if (c.scenes === 0) return 'Not started — no scene ingested';
  if (c.detections === 0) return 'Awaiting detection';
  if (c.origins === 0) return 'Awaiting back-track';
  if (c.candidates === 0) return 'Awaiting AIS correlation';
  if (c.reports === 0) return 'Ready to report';
  return 'Complete';
}

export function AdminPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [roleError, setRoleError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ items: AdminUser[] }>('/admin/users'),
  });
  const providers = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.get<{ items: ProviderHealth[] }>('/admin/providers'),
    refetchInterval: 30_000,
  });
  const quotas = useQuery({
    queryKey: ['admin', 'quotas'],
    queryFn: () => api.get<{ items: QuotaSnapshot[]; note: string }>('/admin/quotas'),
    refetchInterval: 30_000,
  });
  const auditLog = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () => api.get<{ items: AuditEntry[] }>('/admin/audit?limit=50'),
  });
  const investigations = useQuery({
    queryKey: ['admin', 'investigations'],
    queryFn: () => api.get<{ items: AdminInvestigation[]; note: string }>('/admin/investigations'),
  });
  const reports = useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () =>
      api.get<{ items: RenderedReport[]; orphaned: number; note: string }>('/admin/reports'),
  });

  const setRole = useMutation({
    mutationFn: (v: { id: string; role: string }) =>
      api.post(`/admin/users/${v.id}/role`, { role: v.role }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
    onError: (e) =>
      setRoleError(
        e instanceof ApiError ? (e.problem?.detail ?? e.problem?.title ?? e.message) : String(e),
      ),
  });

  if (users.isError) {
    // The API answers 403; saying which role is required is more useful than "forbidden",
    // because the usual cause is being signed in as the wrong account.
    return (
      <main className="page">
        <h1>Administration</h1>
        <div className="panel-error" role="alert">
          <strong>Not permitted</strong>
          <p>
            These screens require the <code>admin</code> role. You are signed in as{' '}
            <code>{me.data?.permissions.role ?? 'unknown'}</code>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="page page-wide">
      <h1>Administration</h1>

      <section className="card">
        <h2>Users and roles</h2>
        <p className="muted">
          Role changes are written to the audit log with the previous and new value.
        </p>
        <div className="form-error" role="alert">
          {roleError ?? ''}
        </div>
        {users.isLoading ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table list-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th className="nowrap">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {(users.data?.items ?? []).map((u) => (
                  <tr key={u._id}>
                    <td className="mono">{u.email}</td>
                    <td>{u.name}</td>
                    <td>
                      <select
                        value={u.role}
                        aria-label={`Role for ${u.email}`}
                        disabled={setRole.isPending || u._id === me.data?.user._id}
                        onChange={(e) => {
                          setRoleError(null);
                          setRole.mutate({ id: u._id, role: e.target.value });
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      {u._id === me.data?.user._id ? (
                        // Locked deliberately: an admin who demotes themselves cannot undo it,
                        // and if they were the only admin the deployment has no way back in.
                        <span className="field-hint"> your own account</span>
                      ) : null}
                    </td>
                    <td className="mono nowrap">
                      {u.lastLoginAt ? formatUtc(u.lastLoginAt) : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Provider health</h2>
        <p className="muted">
          Live circuit-breaker state. AVAILABLE means calls are flowing; TRIPPED means too many
          failures, so calls are refused immediately instead of waiting on a provider that is not
          answering; TESTING means the next call decides whether it has recovered. A provider with
          no credential is skipped by the chain — that is not a failure, and the chain advances past
          it.
        </p>
        <div className="table-scroll">
          <table className="data-table list-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Circuit</th>
                <th className="num">Calls</th>
                <th className="num">Failures</th>
                <th className="num nowrap">p95 latency</th>
                <th className="nowrap">Retry at</th>
              </tr>
            </thead>
            <tbody>
              {(providers.data?.items ?? []).map((p) => (
                <tr key={p.provider}>
                  <td className="mono">{p.provider}</td>
                  <td>
                    <CircuitState state={p.circuit.state} configured={p.configured} />
                  </td>
                  <td className="num mono">{p.calls}</td>
                  <td className="num mono">{p.failures}</td>
                  <td className="num mono nowrap">
                    {p.p95LatencyMs == null ? '—' : `${Math.round(p.p95LatencyMs)} ms`}
                  </td>
                  <td className="mono nowrap">
                    {p.circuit.retryAt ? formatUtc(p.circuit.retryAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Quota consumption</h2>
        <p className="muted">{quotas.data?.note}</p>
        <div className="table-scroll">
          <table className="data-table list-table">
            <thead>
              <tr>
                <th>Key</th>
                <th className="num">Used</th>
                <th className="num">Limit</th>
                <th>Period</th>
                <th className="nowrap">Resets</th>
              </tr>
            </thead>
            <tbody>
              {(quotas.data?.items ?? []).map((q) => {
                const pct = q.used != null && q.limit ? q.used / q.limit : 0;
                return (
                  <tr key={q.quotaKey}>
                    <td className="mono">{q.quotaKey}</td>
                    <td className={`num mono ${pct > 0.8 ? 'field-error' : ''}`}>
                      {/* `null` is not zero. A counter we could not read must not render as
                          "nothing consumed" — that is a specific false claim about usage. */}
                      {q.used == null ? 'unknown' : q.used.toLocaleString()}
                    </td>
                    <td className="num mono">{q.limit?.toLocaleString() ?? '—'}</td>
                    <td>{q.period ?? '—'}</td>
                    <td className="mono nowrap">{q.resetAt ? formatUtc(q.resetAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Investigations</h2>
        <p className="muted">
          {investigations.data?.note ??
            'Every investigation on this instance, with per-stage counts so a stalled case ' +
              'shows where it stalled.'}
        </p>
        <div className="table-scroll">
          <table className="data-table list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Owner</th>
                <th className="nowrap">Scenes</th>
                <th className="nowrap">Detections</th>
                <th className="nowrap">Origins</th>
                <th className="nowrap">Candidates</th>
                <th className="nowrap">Reports</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {(investigations.data?.items ?? []).map((i) => (
                <tr key={i._id}>
                  <td>
                    <a href={`/investigations/${i._id}`}>{i.name ?? '(untitled)'}</a>
                    <div className="mono muted">{i._id.slice(-8)}</div>
                  </td>
                  <td className="mono">{i.status ?? '—'}</td>
                  <td>
                    {i.ownerMissing ? (
                      // A creator who was deleted. Nobody inherits the case, so it needs
                      // reassigning before it can be handed to an analyst.
                      <span className="panel-error">owner deleted</span>
                    ) : (
                      (i.ownerEmail ?? '—')
                    )}
                    <div className="muted">
                      {i.memberCount} member{i.memberCount === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td className="mono">{i.counts.scenes}</td>
                  <td className="mono">{i.counts.detections}</td>
                  <td className="mono">{i.counts.origins}</td>
                  <td className="mono">{i.counts.candidates}</td>
                  <td className="mono">{i.counts.reports}</td>
                  <td className="muted">{stalledAt(i.counts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(investigations.data?.items ?? []).length === 0 ? (
          <p className="muted">No investigations exist yet.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Rendered dossiers</h2>
        <p className="muted">
          {reports.data?.note ?? 'Every PDF dossier rendered on this instance.'}
        </p>
        <div className="table-scroll">
          <table className="data-table list-table">
            <thead>
              <tr>
                <th className="nowrap">Rendered (UTC)</th>
                <th>Investigation</th>
                <th className="nowrap">Size</th>
                <th>State</th>
                <th className="nowrap">Download</th>
              </tr>
            </thead>
            <tbody>
              {(reports.data?.items ?? []).map((r) => (
                <tr key={r.filename}>
                  <td className="mono nowrap">
                    {r.renderedAt ? formatUtc(r.renderedAt) : 'unknown'}
                  </td>
                  <td className="mono">
                    {r.investigationExists ? (
                      <a href={`/investigations/${r.investigationId}`}>
                        {r.investigationId.slice(-8)}
                      </a>
                    ) : (
                      r.investigationId.slice(-8)
                    )}
                  </td>
                  <td className="mono nowrap">{Math.round(r.sizeBytes / 1024)} kB</td>
                  <td>
                    {r.orphaned ? (
                      // The file outlived its case. It is real rendered evidence that no
                      // scoped route can return, which is exactly why it is listed here.
                      <span className="panel-error">orphaned — case deleted</span>
                    ) : (
                      <span className="muted">linked</span>
                    )}
                  </td>
                  <td className="nowrap">
                    <a href={`/api/v1/admin/reports/${encodeURIComponent(r.filename)}`} download>
                      PDF
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(reports.data?.items ?? []).length === 0 ? (
          <p className="muted">No dossiers have been rendered yet.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Audit log</h2>
        <p className="muted">
          Append-only, and there is no delete. A log an administrator can edit is not evidence of
          anything. Showing the 50 most recent entries.
        </p>
        <div className="table-scroll">
          <table className="data-table list-table">
            <thead>
              <tr>
                <th className="nowrap">When (UTC)</th>
                <th>Action</th>
                <th>Entity</th>
                <th className="nowrap">Request</th>
              </tr>
            </thead>
            <tbody>
              {(auditLog.data?.items ?? []).map((a) => (
                <tr key={a._id}>
                  <td className="mono nowrap">{formatUtc(a.at)}</td>
                  <td className="mono">{a.action}</td>
                  <td className="mono">
                    {a.entityType} <span className="muted">{a.entityId.slice(-8)}</span>
                  </td>
                  <td className="mono muted nowrap">{a.requestId?.slice(0, 8) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(auditLog.data?.items ?? []).length === 0 ? (
          <p className="muted">No audited actions yet.</p>
        ) : null}
      </section>
    </main>
  );
}
