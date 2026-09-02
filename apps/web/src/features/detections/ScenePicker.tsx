import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import {
  useCatalogueSearch,
  useIngestScene,
  useInvestigation,
  type CatalogueItem,
} from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Add a scene by choosing an acquisition, rather than by typing a product id.
 *
 * A Sentinel-1 product id is 67 characters of orbit numbers and datatake ids. Asking an
 * analyst to copy one across from another screen is an invitation to transpose a digit and
 * get a 404 that looks like an outage — and it makes the catalogue and the workspace two
 * places holding one idea.
 *
 * So the picker searches the catalogue for THIS investigation's own AOI and window and offers
 * what came back, described the way an analyst thinks about it: when it was acquired, which
 * platform, which orbit direction, how much of the AOI it covers.
 *
 * INGESTIBILITY IS SHOWN, NOT HIDDEN. Ingest resolves product ids against the Planetary
 * Computer `sentinel-1-rtc` collection, because those products are radiometrically
 * terrain-corrected already. An acquisition from another provider is a real scene that this
 * pipeline cannot currently read, and the honest thing is to list it, say so, and say why —
 * not to silently drop it and leave someone wondering where the overpass they can see in the
 * catalogue went.
 */

const INGESTIBLE_COLLECTION = 'sentinel-1-rtc';

interface Props {
  investigationId: string;
}

function describe(item: CatalogueItem): string {
  const bits = [
    formatUtc(item.acquiredAt),
    item.platform,
    item.orbitDirection ? item.orbitDirection.slice(0, 3).toLowerCase() : null,
    item.aoiOverlapPct !== null ? `${Math.round(item.aoiOverlapPct)}% of AOI` : null,
    item.provider,
  ].filter(Boolean);
  return bits.join(' · ');
}

export function ScenePicker({ investigationId }: Props) {
  const inv = useInvestigation(investigationId);
  const ingest = useIngestScene(investigationId);
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<string>('');

  const aoi = inv.data?.aoi ?? null;
  const from = inv.data?.windowStart ?? '';
  const to = inv.data?.windowEnd ?? '';
  const ready = Boolean(aoi && from && to);

  const search = useCatalogueSearch(
    ready ? { aoi: aoi as never, from, to, limit: 100 } : null,
    enabled,
  );

  const { ingestible, other } = useMemo(() => {
    const items = search.data?.items ?? [];
    return {
      ingestible: items
        .filter((i) => i.collection === INGESTIBLE_COLLECTION)
        .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt)),
      other: items.filter((i) => i.collection !== INGESTIBLE_COLLECTION),
    };
  }, [search.data]);

  if (!ready) {
    return <p className="muted">This investigation has no area of interest or time window yet.</p>;
  }

  if (!enabled) {
    return (
      <div className="stack-sm">
        <p className="muted">
          Search the satellite catalogues for acquisitions over this investigation&apos;s area and
          window, then pick one to ingest. Searching queries the providers live and consumes real
          quota, so it runs only when asked.
        </p>
        <button type="button" onClick={() => setEnabled(true)}>
          Find acquisitions
        </button>
      </div>
    );
  }

  if (search.isLoading) return <p className="muted">Querying satellite catalogues…</p>;

  if (search.isError) {
    const problem = search.error instanceof ApiError ? search.error.problem : null;
    return (
      <div className="panel-error" role="alert">
        <strong>No catalogue could be reached</strong>
        <p>{problem?.detail ?? 'Every provider failed. No scene can be added right now.'}</p>
      </div>
    );
  }

  if (ingestible.length === 0) {
    return (
      <div className="stack-sm">
        <p className="muted">
          {other.length === 0
            ? 'No acquisitions cover this area and window. That is a statement about provider coverage, not about whether a scene exists.'
            : `${other.length} acquisition(s) cover this area and window, but none from the ` +
              `${INGESTIBLE_COLLECTION} collection. Ingest reads terrain-corrected products only, ` +
              'so these cannot be windowed here.'}
        </p>
        <button type="button" onClick={() => void search.refetch()}>
          Search again
        </button>
      </div>
    );
  }

  const problem = ingest.error instanceof ApiError ? ingest.error.problem : null;

  return (
    <div className="stack-sm scene-picker">
      <label htmlFor="scene-pick">Acquisition</label>
      <select
        id="scene-pick"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        disabled={ingest.isPending}
      >
        <option value="">
          {ingestible.length} acquisition{ingestible.length === 1 ? '' : 's'} available — choose
          one…
        </option>
        {ingestible.map((i) => (
          <option key={i.productId} value={i.productId}>
            {describe(i)}
          </option>
        ))}
      </select>

      {/* The full id, verbatim and untruncated: it is what an evaluator uses to retrieve the
          same acquisition themselves (13_REAL_DATA_POLICY §13.9). */}
      {selected ? <p className="mono muted scene-picker-id">{selected}</p> : null}

      <div className="row-actions">
        <button
          type="button"
          disabled={!selected || ingest.isPending}
          onClick={() => ingest.mutate(selected)}
        >
          {ingest.isPending ? 'Queueing…' : 'Ingest this scene'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => void search.refetch()}>
          Search again
        </button>
      </div>

      {ingest.isError ? (
        <div className="panel-error" role="alert">
          <strong>Could not queue the ingest</strong>
          <p>{problem?.detail ?? 'The request was refused.'}</p>
        </div>
      ) : null}

      {ingest.isSuccess ? (
        <p className="muted">
          {ingest.data?.deduplicated
            ? 'That scene was already queued for this investigation; reusing the existing job rather than reading the provider twice.'
            : 'Queued. The worker windows the scene to the AOI, writes a COG, and runs detection.'}
        </p>
      ) : null}

      {other.length > 0 ? (
        <details className="scene-picker-other">
          <summary className="muted">
            {other.length} further acquisition{other.length === 1 ? '' : 's'} found that cannot be
            ingested
          </summary>
          <ul className="muted">
            {other.map((i) => (
              <li key={i.productId}>
                <span className="mono">{describe(i)}</span> — collection{' '}
                <span className="mono">{i.collection}</span>, not terrain-corrected
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
