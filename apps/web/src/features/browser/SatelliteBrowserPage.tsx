import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useCatalogueSearch,
  useCreateInvestigationFromScene,
  useProviderHealth,
  type CatalogueItem,
} from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { parsePolygon } from '../../lib/geo.ts';
import { formatUtc } from '../../lib/format.ts';
import { AoiPicker, presetIdForBbox } from '../../components/AoiPicker.tsx';
import { UploadSarPanel } from './UploadSarPanel.tsx';

/**
 * `/browser` — Satellite Browser.
 *
 * A live search of the real Sentinel-1 archive through the existing provider chain
 * (Copernicus Data Space + Microsoft Planetary Computer + ASF). Nothing here is stored or
 * synthesised; every row is a provider record with its verbatim product id. "Create
 * investigation from this scene" runs the normal create + ingest workflow.
 */

type OrbitFilter = 'ANY' | 'ASCENDING' | 'DESCENDING';
type PolFilter = 'ANY' | 'VV' | 'VH';
type TypeFilter = 'ANY' | 'RTC' | 'RAW';

function centroidOf(item: CatalogueItem): [number, number] | null {
  if (item.footprint?.coordinates?.[0]?.length) {
    const ring = item.footprint.coordinates[0]!;
    const lons = ring.map((c) => c[0]!);
    const lats = ring.map((c) => c[1]!);
    return [
      (Math.min(...lons) + Math.max(...lons)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
  }
  if (item.bbox) {
    return [(item.bbox[0] + item.bbox[2]) / 2, (item.bbox[1] + item.bbox[3]) / 2];
  }
  return null;
}

function hasPreview(item: CatalogueItem): boolean {
  const a = item.assets ?? {};
  return Boolean(a.rendered_preview ?? a.thumbnail ?? a.preview ?? a.quicklook);
}

function bytes(n: number | null): string {
  if (n == null) return '—';
  const mb = n / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function shortName(productId: string): string {
  // e.g. S1C_IW_GRDH_1SDV_20250921T200737_..._rtc → "S1C IW GRDH · 2025-09-21 20:07"
  const m = productId.match(/^(S1[ABC])_(\w+?)_(\w+?)_.*?(\d{8})T(\d{6})/);
  if (!m) return productId.slice(0, 32);
  const [, sat, mode, prod, d, t] = m;
  return `${sat} ${mode} ${prod} · ${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)} ${t!.slice(0, 2)}:${t!.slice(2, 4)}`;
}

function SceneCard({
  item,
  aoi,
  onOpened,
}: {
  item: CatalogueItem;
  aoi: { type: 'Polygon'; coordinates: number[][][] } | null;
  onOpened: (id: string) => void;
}) {
  const create = useCreateInvestigationFromScene();
  const [copied, setCopied] = useState(false);
  const c = centroidOf(item);
  const productType = item.preprocessed
    ? `${item.collection} · RTC`
    : item.collection || (item.mode ? `${item.platform} ${item.mode}` : item.platform);

  const acq = new Date(item.acquiredAt);
  const day = 24 * 3_600_000;
  const area =
    aoi ??
    (item.footprint
      ? item.footprint
      : c
        ? {
            type: 'Polygon' as const,
            coordinates: [
              [
                [c[0] - 0.2, c[1] - 0.2],
                [c[0] + 0.2, c[1] - 0.2],
                [c[0] + 0.2, c[1] + 0.2],
                [c[0] - 0.2, c[1] + 0.2],
                [c[0] - 0.2, c[1] - 0.2],
              ],
            ],
          }
        : null);

  const createFromScene = () => {
    if (!area) return;
    create.mutate(
      {
        productId: item.productId,
        name: shortName(item.productId),
        aoi: area,
        windowStart: new Date(acq.getTime() - day).toISOString(),
        windowEnd: new Date(acq.getTime() + day).toISOString(),
        reportedIncidentAt: item.acquiredAt,
        collection: item.collection || undefined,
      },
      { onSuccess: (r) => onOpened(r.investigationId) },
    );
  };

  const err = create.error instanceof ApiError ? create.error : null;

  return (
    <article className="scene-card">
      <div className="scene-preview">
        {/* Provider quicklooks are cross-origin and the app CSP is 'self'-only by design,
            so the preview is a compact identity tile; full metadata is below and the
            "Provider metadata" link opens the provider's own record. */}
        <div className="scene-preview-none">
          <span className="mono">{item.platform || 'SENTINEL-1'}</span>
          <span className="mono">{item.mode ?? 'SAR'}</span>
          <span className="mono">{item.polarisations.join('+') || '—'}</span>
          {hasPreview(item) ? <span className="scene-preview-tag">quicklook available</span> : null}
        </div>
      </div>

      <div className="scene-body">
        <div className="scene-head">
          <h3>{shortName(item.productId)}</h3>
          <span className="token">{item.provider}</span>
          {item.preprocessed ? (
            <span className="token status-ok" title="Radiometrically terrain corrected">
              RTC
            </span>
          ) : null}
        </div>

        <dl className="scene-meta">
          <div>
            <dt>Acquired</dt>
            <dd className="mono">{formatUtc(item.acquiredAt)}</dd>
          </div>
          <div>
            <dt>Product type</dt>
            <dd className="mono">{productType}</dd>
          </div>
          <div>
            <dt>Platform · mode · pol.</dt>
            <dd className="mono">
              {item.platform}
              {item.mode ? ` · ${item.mode}` : ''}
              {item.polarisations.length ? ` · ${item.polarisations.join('+')}` : ''}
            </dd>
          </div>
          <div>
            <dt>Orbit</dt>
            <dd className="mono">{item.orbitDirection ?? '—'}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd className="mono">
              {c ? `${c[1].toFixed(3)}°, ${c[0].toFixed(3)}°` : '—'}
              {item.aoiOverlapPct != null ? ` · AOI overlap ${item.aoiOverlapPct.toFixed(0)}%` : ''}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd className="mono">{bytes(item.sizeBytes)}</dd>
          </div>
        </dl>

        <p className="scene-pid mono" title={item.productId}>
          {item.productId}
        </p>

        {err ? (
          <p className="form-error" role="alert">
            {err.problem?.detail ?? err.message}
          </p>
        ) : null}

        <div className="scene-actions">
          <button
            className="btn-primary"
            onClick={createFromScene}
            disabled={create.isPending || !area}
          >
            {create.isPending ? 'Working…' : 'Process this scene'}
          </button>
          <button
            className="btn-ghost"
            onClick={createFromScene}
            disabled={create.isPending || !area}
          >
            Create investigation from this scene
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              navigator.clipboard?.writeText(item.productId).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => {},
              );
            }}
          >
            {copied ? 'Copied' : 'Copy product ID'}
          </button>
          {item.selfHref ? (
            <a className="btn-ghost" href={item.selfHref} target="_blank" rel="noreferrer">
              Provider metadata
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function SatelliteBrowserPage() {
  const navigate = useNavigate();
  const providers = useProviderHealth();

  const [aoiText, setAoiText] = useState('144.55,13.30,144.95,13.60');
  const [from, setFrom] = useState('2025-09-20T00:00');
  const [to, setTo] = useState('2025-09-23T00:00');
  const [orbit, setOrbit] = useState<OrbitFilter>('ANY');
  const [pol, setPol] = useState<PolFilter>('ANY');
  const [ptype, setPtype] = useState<TypeFilter>('ANY');
  const [submitted, setSubmitted] = useState<{
    aoi: { type: 'Polygon'; coordinates: number[][][] };
    from: string;
    to: string;
  } | null>(null);

  const parsed = useMemo(() => parsePolygon(aoiText), [aoiText]);

  const query = useCatalogueSearch(
    submitted ? { ...submitted, platforms: 'SENTINEL-1', limit: 100 } : null,
    Boolean(submitted),
  );

  const runSearch = () => {
    if (!parsed.polygon || !from || !to) return;
    setSubmitted({
      aoi: parsed.polygon,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
  };

  const allItems = query.data?.items ?? [];
  const items = allItems.filter((i) => {
    if (orbit !== 'ANY' && i.orbitDirection !== orbit) return false;
    if (pol !== 'ANY' && !i.polarisations.includes(pol)) return false;
    if (ptype === 'RTC' && !i.preprocessed) return false;
    if (ptype === 'RAW' && i.preprocessed) return false;
    return true;
  });
  const statuses = query.data?.providerStatus ?? [];

  return (
    <main className="page page-wide dash">
      <header className="page-head">
        <div>
          <h1>Satellite Browser</h1>
          <p className="muted">
            Live search of the real Sentinel-1 archive via Copernicus Data Space, Microsoft
            Planetary Computer and ASF. Results are not stored; each product id is the exact
            identifier an evaluator can look up.
          </p>
        </div>
      </header>

      <section className="card">
        <div className="browser-controls">
          <div className="browser-aoi">
            <AoiPicker onPick={setAoiText} selectedId={presetIdForBbox(aoiText)} />
            <label htmlFor="b-aoi">
              Area of interest — <code>west,south,east,north</code> or GeoJSON Polygon
            </label>
            <textarea
              id="b-aoi"
              rows={3}
              className="mono"
              spellCheck={false}
              value={aoiText}
              onChange={(e) => setAoiText(e.target.value)}
            />
            <div className="field-error">{parsed.error ?? ''}</div>
          </div>

          <div className="browser-filters">
            <div>
              <label htmlFor="b-from">From (UTC)</label>
              <input
                id="b-from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="b-to">To (UTC)</label>
              <input
                id="b-to"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="b-orbit">Orbit</label>
              <select
                id="b-orbit"
                value={orbit}
                onChange={(e) => setOrbit(e.target.value as OrbitFilter)}
              >
                <option value="ANY">Any</option>
                <option value="ASCENDING">Ascending</option>
                <option value="DESCENDING">Descending</option>
              </select>
            </div>
            <div>
              <label htmlFor="b-pol">Polarisation</label>
              <select id="b-pol" value={pol} onChange={(e) => setPol(e.target.value as PolFilter)}>
                <option value="ANY">Any</option>
                <option value="VV">VV</option>
                <option value="VH">VH</option>
              </select>
            </div>
            <div>
              <label htmlFor="b-type">Product type</label>
              <select
                id="b-type"
                value={ptype}
                onChange={(e) => setPtype(e.target.value as TypeFilter)}
              >
                <option value="ANY">Any</option>
                <option value="RTC">RTC only</option>
                <option value="RAW">Non-RTC only</option>
              </select>
            </div>
          </div>

          <button
            className="btn-primary"
            onClick={runSearch}
            disabled={!parsed.polygon || !from || !to || query.isFetching}
          >
            {query.isFetching ? 'Searching…' : 'Search Sentinel-1 archive'}
          </button>
        </div>
      </section>

      <UploadSarPanel aoi={parsed.polygon} />

      {providers.data?.items?.length ? (
        <section className="card browser-providers">
          {providers.data.items.map((p) => (
            <span
              key={p.provider}
              className={`token ${p.configured ? (p.circuit.state === 'open' ? 'status-warn' : 'status-ok') : ''}`}
              title={p.configured ? `circuit ${p.circuit.state}` : 'not configured'}
            >
              {p.provider} {p.configured ? '' : '· not configured'}
            </span>
          ))}
        </section>
      ) : null}

      {!submitted ? (
        <section className="card">
          <div className="empty">
            <p>Set an area and a time window, then search the Sentinel-1 archive.</p>
            <p className="field-hint">
              The default box is the verified demo area (Apra Harbour, Guam) — searching it should
              return the 2025-09-21 acquisition used across the app.
            </p>
          </div>
        </section>
      ) : query.isLoading ? (
        <section className="card">
          <p className="muted">Querying satellite catalogues…</p>
        </section>
      ) : query.isError ? (
        <section className="card">
          <p className="form-error" role="alert">
            {query.error instanceof ApiError
              ? (query.error.problem?.detail ?? query.error.message)
              : 'Catalogue search failed.'}
          </p>
          <button className="btn-ghost" onClick={() => void query.refetch()}>
            Retry
          </button>
        </section>
      ) : allItems.length === 0 ? (
        <section className="card">
          <div className="empty">
            <p>No Sentinel-1 acquisitions in this area and window.</p>
            <p className="field-hint">
              The catalogues answered — they simply hold nothing here. Widen the window, or move the
              area of interest.
            </p>
          </div>
        </section>
      ) : (
        <>
          <p className="muted">
            {items.length} of {allItems.length} Sentinel-1 acquisition
            {allItems.length === 1 ? '' : 's'}{' '}
            {items.length === allItems.length ? '' : '(after filters) '}intersect this area.
            {statuses.length ? (
              <span className="mono">
                {'  '}
                {statuses.map((s) => `${s.provider}:${s.status}`).join('  ')}
              </span>
            ) : null}
          </p>
          <div className="scene-grid">
            {items.map((item) => (
              <SceneCard
                key={`${item.provider}:${item.productId}`}
                item={item}
                aoi={submitted?.aoi ?? null}
                onOpened={(id) => navigate(`/investigations/${id}`)}
              />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
