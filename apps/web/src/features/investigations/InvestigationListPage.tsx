import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInvestigations, useMe } from '../../api/hooks.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';
import { DeleteInvestigation, canDeleteInvestigation } from './DeleteInvestigation.tsx';

/**
 * `/investigations` — 05_FRONTEND §5.5.3.
 *
 * Cards rather than a table row per case, and the reason is the chain.
 *
 * A row of name/status/AOI/dates answers "does this exist?" — which is never the question an
 * analyst arrives with. They arrive asking "which of these needs me, and for what?", and the
 * status field cannot answer it: `DRAFT` covers a case created a minute ago and one whose
 * ingest failed three stages back. Only the per-stage counts separate those, so each card
 * carries a pipeline strip showing exactly how far the chain got and names the next action.
 *
 * The filter is client-side on purpose. The page loads 50 cases at most, and a round trip per
 * keystroke would make a fast local answer slower and put load on a database for a question
 * already answered in memory.
 */

interface Counts {
  scenes: number;
  detections: number;
  origins: number;
  candidates: number;
}

/** The chain, in order. Each stage is reached only once the previous one produced something. */
const STAGES = [
  { key: 'scenes', label: 'Scene' },
  { key: 'detections', label: 'Detection' },
  { key: 'origins', label: 'Origin' },
  { key: 'candidates', label: 'Candidates' },
] as const;

function nextAction(c: Counts): { text: string; done: boolean } {
  if (c.scenes === 0) return { text: 'Add a satellite scene', done: false };
  if (c.detections === 0) return { text: 'Awaiting detection', done: false };
  if (c.origins === 0) return { text: 'Review detections, then back-track', done: false };
  if (c.candidates === 0) return { text: 'Correlate against AIS', done: false };
  return { text: 'Ranked — review the evidence', done: true };
}

export function InvestigationListPage() {
  const { data, isLoading, isError, error, refetch } = useInvestigations({ limit: 50 });
  const me = useMe();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const items = useMemo(() => data?.items ?? [], [data]);

  const statuses = useMemo(
    () => [...new Set(items.map((i) => i.status).filter(Boolean))].sort(),
    [items],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (statusFilter && i.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        i.name.toLowerCase().includes(needle) ||
        (i.incidentReference ?? '').toLowerCase().includes(needle)
      );
    });
  }, [items, q, statusFilter]);

  if (isLoading) {
    return (
      <main className="page page-wide">
        <h1>Investigations</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="page page-wide">
        <h1>Investigations</h1>
        {/* Errors state the cause and the next action (04_UIUX §4.11). */}
        <div className="panel-error" role="alert">
          <strong>Could not load investigations.</strong>
          <p>{(error as Error).message}</p>
          <button onClick={() => void refetch()}>Retry</button>
        </div>
      </main>
    );
  }

  return (
    <main className="page page-wide">
      <header className="page-head">
        <div>
          <h1>Investigations</h1>
          <p className="muted">
            {items.length === 0
              ? 'No cases yet.'
              : `${items.length} case${items.length === 1 ? '' : 's'}, ` +
                `${items.filter((i) => (i.counts?.scenes ?? 0) > 0).length} with a scene ingested.`}
          </p>
        </div>
        <Link className="btn-primary" to="/investigations/new">
          New investigation
        </Link>
      </header>

      {items.length === 0 ? (
        // Empty states say WHY and WHAT NEXT — never a shrug (04_UIUX §4.8.1).
        <div className="empty-state">
          <h2>No investigations yet</h2>
          <p>
            Create one by defining an area of interest and a UTC time window. VARUNA will then
            search real satellite catalogues for acquisitions covering it.
          </p>
          <Link className="btn-primary" to="/investigations/new">
            Create an investigation
          </Link>
        </div>
      ) : (
        <>
          <div className="list-filters">
            <label className="sr-only" htmlFor="inv-search">
              Filter by name or reference
            </label>
            <input
              id="inv-search"
              type="search"
              placeholder="Filter by name or incident reference…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="sr-only" htmlFor="inv-status">
              Filter by status
            </label>
            <select
              id="inv-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {shown.length === 0 ? (
            <p className="muted">No case matches that filter. {items.length} exist in total.</p>
          ) : (
            <ul className="inv-grid">
              {shown.map((i) => {
                const counts: Counts = i.counts ?? {
                  scenes: 0,
                  detections: 0,
                  origins: 0,
                  candidates: 0,
                };
                const next = nextAction(counts);
                return (
                  <li className="inv-card" key={i._id}>
                    <div className="inv-card-head">
                      <Link className="inv-name" to={`/investigations/${i._id}`}>
                        {i.name}
                      </Link>
                      <span className="token">{i.status}</span>
                    </div>

                    {i.incidentReference ? (
                      <p className="mono muted inv-ref">{i.incidentReference}</p>
                    ) : null}

                    <div className="inv-stages">
                      {STAGES.map((st) => {
                        const n = counts[st.key];
                        return (
                          <div
                            key={st.key}
                            className={`inv-stage ${n > 0 ? 'reached' : ''}`}
                            title={`${st.label}: ${n}`}
                          >
                            <span className="inv-stage-n">{n}</span>
                            <span className="inv-stage-label">{st.label}</span>
                          </div>
                        );
                      })}
                    </div>

                    <p className={`inv-next ${next.done ? 'done' : ''}`}>{next.text}</p>

                    <dl className="inv-meta">
                      <div>
                        <dt>Area</dt>
                        <dd className="mono">{formatAreaKm2(i.aoiAreaKm2)}</dd>
                      </div>
                      <div>
                        <dt>Window (UTC)</dt>
                        <dd className="mono">
                          {formatUtc(i.windowStart)} → {formatUtc(i.windowEnd)}
                        </dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd className="mono">{formatUtc(i.updatedAt)}</dd>
                      </div>
                    </dl>

                    {/* Offered only to whoever the API would actually let do it — its lead,
                        the analyst who created it, or an administrator. */}
                    {canDeleteInvestigation(i, me.data?.user) ? (
                      <div className="inv-card-actions">
                        <DeleteInvestigation
                          investigationId={i._id}
                          name={i.name}
                          counts={counts}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
