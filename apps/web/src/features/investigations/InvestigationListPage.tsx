import { Link } from 'react-router-dom';
import { useInvestigations } from '../../api/hooks.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

/**
 * `/investigations` — 05_FRONTEND §5.5.3.
 * Virtualisation, URL-reflected filters and hover-prefetch land with the workspace shell
 * in Phase 10; this is the functional list on top of the Phase 2 API.
 */
export function InvestigationListPage() {
  const { data, isLoading, isError, error, refetch } = useInvestigations({ limit: 50 });

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

  const items = data?.items ?? [];

  return (
    <main className="page page-wide">
      <header className="page-head">
        <h1>Investigations</h1>
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
        <table className="data-table list-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th className="num nowrap">AOI</th>
              <th>Window (UTC)</th>
              <th className="nowrap">Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <tr key={inv._id}>
                <td>
                  <Link to={`/investigations/${inv._id}`}>{inv.name}</Link>
                  {inv.incidentReference ? (
                    <span className="mono muted"> · {inv.incidentReference}</span>
                  ) : null}
                </td>
                <td>
                  <span className="token">{inv.status}</span>
                </td>
                <td className="num mono nowrap">{formatAreaKm2(inv.aoiAreaKm2)}</td>
                <td className="mono nowrap">
                  {formatUtc(inv.windowStart)} → {formatUtc(inv.windowEnd)}
                </td>
                <td className="mono nowrap">{formatUtc(inv.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
