import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * `/admin` — 06_BACKEND §6.4.10.
 *
 * Users and roles, live provider health, quota consumption and the audit log. Every one of
 * these endpoints existed with no route to reach it.
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

const ROLES = ['viewer', 'analyst', 'lead', 'admin'] as const;

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
          Live circuit-breaker state. An UNCONFIGURED provider has no credential and is skipped by
          the chain — it is not a failure, and the chain advances past it.
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
                    <span
                      className={`token ${
                        !p.configured
                          ? 'status-neutral'
                          : p.circuit.state === 'CLOSED'
                            ? 'status-ok'
                            : 'status-danger'
                      }`}
                    >
                      {p.configured ? p.circuit.state : 'NOT CONFIGURED'}
                    </span>
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
