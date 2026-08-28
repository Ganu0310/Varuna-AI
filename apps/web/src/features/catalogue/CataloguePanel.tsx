import { useState } from 'react';
import { useCatalogueSearch, type CatalogueItem } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { CatalogueResults } from './CatalogueResults.tsx';
import { ProviderStatusStrip } from './ProviderStatusStrip.tsx';

/**
 * Live catalogue search panel — 06_BACKEND §6.4.3, 05_FRONTEND §5.5.4.
 *
 * Three outcomes are kept distinct, because conflating them is how a system misleads:
 *   • scenes found                          → the table
 *   • providers answered, none had coverage → an explicit "no acquisitions" state
 *   • no provider could be reached          → an error stating the CONSEQUENCE
 *
 * The search only runs when asked (`enabled`), because it consumes a real provider quota.
 */
interface Props {
  aoi: { type: 'Polygon'; coordinates: number[][][] } | null;
  from: string;
  to: string;
  autoRun?: boolean;
  onHover?: (item: CatalogueItem | null) => void;
}

export function CataloguePanel({ aoi, from, to, autoRun = false, onHover }: Props) {
  const [enabled, setEnabled] = useState(autoRun);
  const ready = Boolean(aoi && from && to);

  const query = useCatalogueSearch(ready ? { aoi: aoi!, from, to, limit: 100 } : null, enabled);

  if (!ready) {
    return (
      <p className="muted">
        Set an area of interest and a time window to search the satellite catalogues.
      </p>
    );
  }

  if (!enabled) {
    return (
      <div className="stack-sm">
        <p className="muted">
          Searching queries the Copernicus, Planetary Computer and ASF catalogues live. Results are
          not stored.
        </p>
        <button type="button" onClick={() => setEnabled(true)}>
          Search catalogues
        </button>
      </div>
    );
  }

  if (query.isLoading) {
    return <p className="muted">Querying satellite catalogues…</p>;
  }

  if (query.isError) {
    const problem = query.error instanceof ApiError ? query.error.problem : null;
    return (
      <div className="panel-error" role="alert">
        <strong>{problem?.title ?? 'Catalogue search failed'}</strong>
        <p>{problem?.detail ?? (query.error as Error).message}</p>
        {/* Which providers were tried, and what each did — 06_BACKEND §6.5.1. */}
        {problem?.attempted?.length ? (
          <ul className="mono attempted">
            {problem.attempted.map((a) => (
              <li key={a.provider}>
                {a.provider}: {a.outcome}
              </li>
            ))}
          </ul>
        ) : null}
        {/* What this failure MEANS for the analyst, not just that it happened. */}
        {problem?.consequence ? <p className="consequence">{problem.consequence}</p> : null}
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const items = query.data?.items ?? [];
  const statuses = query.data?.providerStatus ?? [];

  return (
    <div className="stack-sm">
      <ProviderStatusStrip statuses={statuses} />

      {items.length === 0 ? (
        <div className="empty-state">
          <h3>No acquisitions in this window</h3>
          {/*
            A real answer about coverage, NOT a failure. Saying so plainly is the difference
            between an honest null result and an apparent malfunction (08_APP_FLOW §8.3).
          */}
          <p>
            The catalogues were queried successfully and hold no acquisitions covering this area in
            this window. Widening the time window, or accepting a lower AOI overlap, is the usual
            next step.
          </p>
        </div>
      ) : (
        <>
          <p className="muted">
            {items.length} {items.length === 1 ? 'acquisition' : 'acquisitions'} intersect this area
            of interest in this window.
          </p>
          <CatalogueResults items={items} onHover={onHover} />
        </>
      )}

      <button type="button" className="btn-ghost" onClick={() => void query.refetch()}>
        Re-run search
      </button>
    </div>
  );
}
