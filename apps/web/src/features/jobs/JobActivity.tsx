import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Live job activity — 08_APP_FLOW §8.7.
 *
 * Ingest, back-tracking and correlation are asynchronous and take minutes. Until now the UI
 * said "Queuing…" for a moment and then nothing: no progress, no completion, and — worst —
 * no failure. A job that died left the analyst watching a screen that never changed, with the
 * reason sitting in a log they cannot see.
 *
 * The failure reason is shown VERBATIM. The provider chain's errors are specific and
 * actionable ("HYCOM covers 1994-2024-09-05, requested 2025-09-21"), and replacing them with
 * "job failed" would throw away the only thing that tells an analyst what to do next.
 *
 * Rows refresh on the socket's `job:progress` / `job:completed` / `job:failed` events, which
 * already invalidate the `jobs` query; the poll is a floor for when the socket is down.
 */

interface Job {
  _id: string;
  kind: string;
  queue: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress?: { pct?: number; stage?: string; message?: string } | null;
  attempts: number;
  createdAt: string;
  completedAt?: string | null;
  failedReason?: string | null;
  error?: { message?: string; consequence?: string } | null;
}

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export function JobActivity({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();

  const jobs = useQuery({
    queryKey: ['jobs', investigationId],
    queryFn: () => api.get<{ items: Job[] }>(`/jobs?investigationId=${investigationId}`),
    enabled: Boolean(investigationId),
    // A floor, not the primary mechanism: the socket invalidates this query on every job
    // event. Polling alone would make a 2-second stage change invisible.
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some((j) => ACTIVE.has(j.status)) ? 2_000 : 30_000,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/jobs/${id}/retry`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/jobs/${id}/cancel`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const items = jobs.data?.items ?? [];
  if (jobs.isLoading) return <p className="muted">Loading activity…</p>;
  if (items.length === 0) {
    return (
      <p className="muted">
        No jobs yet. Ingesting a scene, back-tracking and correlation all run here.
      </p>
    );
  }

  const err = (e: unknown) =>
    e instanceof ApiError ? (e.problem?.detail ?? e.problem?.title ?? e.message) : String(e);

  return (
    <ul className="job-list">
      {items.map((j) => {
        const active = ACTIVE.has(j.status);
        const pct = Math.max(0, Math.min(100, j.progress?.pct ?? 0));
        const reason = j.failedReason ?? j.error?.message ?? null;
        return (
          <li key={j._id} className={`job job-${j.status.toLowerCase()}`}>
            <div className="job-head">
              <span className="mono job-kind">{j.kind}</span>
              <span className={`token status-${statusToken(j.status)}`}>{j.status}</span>
              {j.attempts > 1 ? <span className="muted mono">attempt {j.attempts}</span> : null}
            </div>

            {active ? (
              <>
                <div
                  className="job-bar"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${j.kind} progress`}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
                <p className="job-stage mono">
                  {pct}% · {j.progress?.stage ?? 'starting'}
                  {j.progress?.message ? ` — ${j.progress.message}` : ''}
                </p>
              </>
            ) : null}

            {reason ? (
              // Verbatim. A provider's own message names the actual limit that was hit,
              // which is what tells an analyst whether to change the date, the area, or
              // give up on that provider.
              <p className="job-reason" role="alert">
                {reason}
                {j.error?.consequence ? (
                  <span className="muted"> {j.error.consequence}</span>
                ) : null}
              </p>
            ) : null}

            <div className="job-foot">
              <span className="muted mono">
                {j.completedAt ? formatUtc(j.completedAt) : formatUtc(j.createdAt)}
              </span>
              {j.status === 'FAILED' ? (
                <button className="btn-ghost" onClick={() => retry.mutate(j._id)}>
                  Retry
                </button>
              ) : null}
              {active ? (
                <button className="btn-ghost" onClick={() => cancel.mutate(j._id)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
      {retry.isError || cancel.isError ? (
        <li className="form-error" role="alert">
          {err(retry.error ?? cancel.error)}
        </li>
      ) : null}
    </ul>
  );
}

function statusToken(s: Job['status']): string {
  if (s === 'COMPLETED') return 'ok';
  if (s === 'FAILED') return 'danger';
  if (s === 'CANCELLED') return 'neutral';
  return 'info';
}
