import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Who can see this investigation, and what has been done to it.
 *
 * Both endpoints existed with no UI. Access was effectively unmanageable from the product —
 * a colleague could only be added by writing to the database — and the per-investigation
 * audit trail, which is the record of who changed what, could not be read at all.
 *
 * The audit list is deliberately not filterable or deletable here. It is append-only server
 * side, and a trail an investigator can prune is not a trail.
 */

interface Member {
  userId: string;
  role: 'viewer' | 'analyst' | 'lead' | 'admin';
  email?: string | null;
  name?: string | null;
}

interface AuditEntry {
  _id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  at: string;
  requestId?: string | null;
}

const ROLES = ['viewer', 'analyst', 'lead'] as const;

export function TeamPanel({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('analyst');
  const [error, setError] = useState<string | null>(null);

  const inv = useQuery({
    queryKey: ['investigation', investigationId],
    queryFn: () => api.get<{ members: Member[] }>(`/investigations/${investigationId}`),
  });

  const auditLog = useQuery({
    queryKey: ['investigation-audit', investigationId],
    queryFn: () =>
      api.get<{ items: AuditEntry[] }>(`/investigations/${investigationId}/audit?limit=50`),
  });

  const addMember = useMutation({
    mutationFn: () => api.post(`/investigations/${investigationId}/members`, { userId, role }),
    onSuccess: () => {
      setUserId('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['investigation', investigationId] });
      void qc.invalidateQueries({ queryKey: ['investigation-audit', investigationId] });
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.problem?.detail ?? e.problem?.title ?? e.message) : String(e),
      ),
  });

  const members = inv.data?.members ?? [];

  return (
    <div className="stack-sm">
      <section className="card">
        <h2>Access</h2>
        <p className="muted">
          A member’s role here is scoped to this investigation, and is separate from their account
          role. Every change is written to the trail below.
        </p>

        {members.length === 0 ? (
          <p className="muted">No members recorded.</p>
        ) : (
          <table className="data-table list-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role in this investigation</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="mono">{m.email ?? m.userId}</td>
                  <td>
                    <span className="token">{m.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <label htmlFor="member-id">Add a member by user ID</label>
        <input
          id="member-id"
          className="mono"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="24-character user id"
        />
        <label htmlFor="member-role">Role</label>
        <select
          id="member-role"
          value={role}
          onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <div className="form-error" role="alert">
          {error ?? ''}
        </div>
        <button disabled={!userId || addMember.isPending} onClick={() => addMember.mutate()}>
          {addMember.isPending ? 'Adding…' : 'Add member'}
        </button>
        <p className="field-hint">
          By user ID rather than email: the endpoint takes an ID, and resolving an email to an
          account here would mean exposing a user-lookup to anyone who can edit an investigation.
          Administrators can read IDs from the admin screen.
        </p>
      </section>

      <section className="card">
        <h2>Investigation trail</h2>
        <p className="muted">
          Append-only, and not editable from anywhere in this product. Showing the 50 most recent
          actions on this investigation.
        </p>
        {auditLog.isLoading ? (
          <p className="muted">Loading…</p>
        ) : (auditLog.data?.items ?? []).length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table list-table">
              <thead>
                <tr>
                  <th className="nowrap">When (UTC)</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {(auditLog.data?.items ?? []).map((a) => (
                  <tr key={a._id}>
                    <td className="mono nowrap">{formatUtc(a.at)}</td>
                    <td className="mono">{a.action}</td>
                    <td className="mono muted">
                      {a.entityType} {a.entityId.slice(-8)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
