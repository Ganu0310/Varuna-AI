import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInvestigation, useScenes, useDetections, type Detection } from '../../api/hooks.ts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { MapRoot } from '../../map/MapRoot.tsx';
import { buildLayers } from '../../map/layers.ts';
import { LayerStackControl } from '../../map/LayerStackControl.tsx';
import { TimeScrubber } from '../../components/TimeScrubber.tsx';
import { CandidateRanking } from '../candidates/CandidateRanking.tsx';
import { DetectionsPanel } from '../detections/DetectionsPanel.tsx';
import { OriginPanel } from '../origin/OriginPanel.tsx';
import { JobActivity } from '../jobs/JobActivity.tsx';
import { CommentThread } from './CommentThread.tsx';
import { PipelineProgress } from './PipelineProgress.tsx';
import { InvestigationViews } from '../../components/Breadcrumbs.tsx';
import { TeamPanel } from './TeamPanel.tsx';
import { SensitivityPanel } from '../candidates/SensitivityPanel.tsx';
import { CataloguePanel } from '../catalogue/CataloguePanel.tsx';
import { useLayerStore, useSelectionStore, useTimeStore, useMapStore } from '../../state/stores.ts';
import { vesselsAt } from '../../map/vesselAt.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

type Tab = 'catalogue' | 'scenes' | 'origin' | 'ais' | 'candidates' | 'activity' | 'team';

interface AisCoverage {
  recordCount: number;
  distinctVessels: number;
  medianIntervalSec: number | null;
  assessment: string;
}

interface OriginResponse {
  reason: string;
  origin: {
    status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
    method: string;
    degradationReason: string | null;
    originField?: { support90?: { type: 'Polygon'; coordinates: number[][][] } };
    releaseWindow?: {
      earliest: string;
      latest: string;
      mostLikelyStart: string;
      mostLikelyEnd: string;
      status: 'OK' | 'WIDE';
    };
  } | null;
}

interface TracksResponse {
  items: Array<{
    mmsi: number;
    line: { type: 'LineString'; coordinates: number[][] } | null;
    times?: number[];
    fixCount: number;
    removedOutlierCount: number;
    gapCount: number;
  }>;
  darkPeriods: Array<{ mmsi: number; durationMin: number; overlapsOriginZone: boolean }>;
}

/**
 * Investigation workspace — 05_FRONTEND §5.5.5.
 *
 * The map is mounted ONCE here and the rail switches what is shown beside it. Tabs never
 * remount `MapRoot`, so camera position and loaded tiles survive navigation (12 F-23).
 */
export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('scenes');

  const { data: inv, isLoading, isError, error } = useInvestigation(id);
  const scenes = useScenes(id);
  const detections = useDetections(id);
  const addLayer = useLayerStore((s) => s.addLayer);
  const layerVisible = useLayerStore((s) => s.layers);
  const setWindow = useTimeStore((s) => s.setWindow);
  const cursor = useTimeStore((s) => s.cursor);
  const fitBounds = useMapStore((s) => s.fitBounds);
  const hovered = useSelectionStore((s) => s.hovered);
  const selected = useSelectionStore((s) => s.selected);

  /**
   * Tiles for the first READY scene — M1.
   *
   * `enabled` on a READY scene only: a CATALOGUED scene has no raster stored, and asking for
   * its tiles returns 404. Waiting for READY keeps a normal pre-ingest state out of the
   * error path.
   */
  const readyScene = (scenes.data?.items ?? []).find((sc) => sc.status === 'READY');
  const sarTiles = useQuery({
    queryKey: ['scene-tiles', id, readyScene?._id],
    queryFn: () =>
      api.get<{
        tileUrlTemplate: string;
        bounds: [number, number, number, number] | null;
        minZoom: number;
        maxZoom: number;
        attribution: string | null;
      }>(`/investigations/${id}/scenes/${readyScene!._id}/tiles`),
    enabled: Boolean(id && readyScene?._id),
    staleTime: 5 * 60_000,
  });

  const candidates = useQuery({
    queryKey: ['candidates', id],
    queryFn: () => api.get<{ items: unknown[] }>(`/investigations/${id}/candidates`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });

  const coverage = useQuery({
    queryKey: ['ais-coverage', id],
    queryFn: () => api.get<AisCoverage>(`/investigations/${id}/ais/coverage`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  /**
   * The origin estimate — M5's map half.
   *
   * The zone has been computed, stored and printed in the dossier since Phase 7, but was
   * never drawn. `reason: 'NOT_RUN'` comes back when back-tracking has not been run, which
   * is a normal state rather than an error.
   */
  const origin = useQuery({
    queryKey: ['origin', id],
    queryFn: () => api.get<OriginResponse>(`/investigations/${id}/origin`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  const tracks = useQuery({
    queryKey: ['ais-tracks', id],
    queryFn: () => api.get<TracksResponse>(`/investigations/${id}/ais/tracks?limit=60`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  // Time window follows the investigation.
  useEffect(() => {
    if (inv) setWindow(inv.windowStart, inv.windowEnd);
  }, [inv, setWindow]);

  // Register layers WITH their provenance. A layer whose data has no source record is
  // refused by the store rather than drawn (13_REAL_DATA_POLICY §13.4 L4).
  useEffect(() => {
    if (!inv) return;
    addLayer(
      {
        id: 'aoi',
        label: 'Area of interest',
        visible: true,
        opacity: 1,
        provenance: {
          provider: 'Analyst',
          datasetId: 'investigation-aoi',
          externalId: inv._id,
          licence: 'internal',
        },
      },
      id!,
    );
  }, [inv, addLayer, id]);

  useEffect(() => {
    const scene = scenes.data?.items[0];
    if (!scene) return;
    addLayer(
      {
        id: 'sar-raster',
        label: `SAR ${scene.platform} ${scene.polarisations[0] ?? ''}`,
        visible: true,
        opacity: 0.9,
        provenance: {
          provider: scene.provenance.provider,
          datasetId: scene.provenance.datasetId,
          externalId: scene.provenance.externalId,
          licence: scene.provenance.licence,
        },
      },
      id!,
    );
  }, [scenes.data, addLayer, id]);

  // The origin layer is registered only once an estimate exists, and its label carries the
  // method. A FOOTPRINT_PROXIMITY zone and a back-tracked drift field are different kinds of
  // claim, and the legend must not present them as the same thing.
  useEffect(() => {
    const o = origin.data?.origin;
    if (!o?.originField?.support90) return;
    addLayer(
      {
        id: 'origin-field',
        label:
          o.status === 'DEGRADED'
            ? `Origin zone (${o.method === 'FOOTPRINT_PROXIMITY' ? 'proximity, degraded' : 'degraded'})`
            : 'Origin zone (drift 90%)',
        visible: true,
        opacity: 1,
        provenance: {
          provider: 'VARUNA',
          datasetId: `${o.method.toLowerCase()}-v1`,
          externalId: id ?? '',
          licence: 'internal',
        },
      },
      id!,
    );
  }, [origin.data, addLayer, id]);

  useEffect(() => {
    if (!(tracks.data?.items ?? []).some((t) => t.times?.length)) return;
    addLayer(
      {
        id: 'vessel-positions',
        label: 'Vessels at cursor',
        visible: true,
        opacity: 1,
        provenance: {
          provider: 'NOAA Marine Cadastre',
          datasetId: 'AIS Vessel Traffic Data',
          externalId: id ?? '',
          licence: 'US Government work — public domain',
        },
      },
      id!,
    );
  }, [tracks.data, addLayer, id]);

  useEffect(() => {
    const d = detections.data?.items[0];
    if (!d) return;
    addLayer(
      {
        id: 'slick-polygons',
        label: 'Detections',
        visible: true,
        opacity: 1,
        provenance: {
          provider: d.provenance.provider,
          datasetId: d.provenance.datasetId,
          externalId: d.provenance.externalId,
          licence: 'internal',
        },
      },
      id!,
    );
  }, [detections.data, addLayer, id]);

  useEffect(() => {
    if (!tracks.data || tracks.data.items.length === 0) return;
    addLayer(
      {
        id: 'ais-tracks',
        label: 'AIS tracks',
        visible: true,
        opacity: 1,
        provenance: {
          provider: 'NOAA Marine Cadastre',
          datasetId: 'AIS Vessel Traffic Data',
          externalId: 'ais_positions time-series',
          licence: 'U.S. Government work — public domain',
        },
      },
      id!,
    );
  }, [tracks.data, addLayer, id]);

  // Frame the AOI once the map is ready.
  useEffect(() => {
    if (!inv) return;
    const ring = inv.aoi.coordinates[0]!;
    const lons = ring.map((c) => c[0]!);
    const lats = ring.map((c) => c[1]!);
    const t = setTimeout(
      () => fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]),
      600,
    );
    return () => clearTimeout(t);
  }, [inv, fitBounds]);

  const highlightMmsi =
    selected.kind === 'candidate' || selected.kind === 'vessel' ? selected.mmsi : null;
  const hoveredMmsi =
    hovered.kind === 'candidate' || hovered.kind === 'vessel' ? hovered.mmsi : null;

  /**
   * Vessel positions at the time cursor — M9.
   *
   * `cursor` from the store updates at 4 Hz rather than every frame: the markers move
   * smoothly enough at that rate, and rebuilding the deck.gl layer stack 60 times a second
   * would re-render every panel around the map for no visible gain.
   *
   * `vesselsAt` omits any vessel it cannot place honestly — outside its observed window, or
   * mid dark period — so the count here rises and falls as vessels come in and out of AIS
   * coverage. That is the data, not a bug.
   */
  const vessels = useMemo(() => vesselsAt(tracks.data?.items ?? [], cursor), [tracks.data, cursor]);

  const layers = useMemo(
    () =>
      buildLayers({
        aoi: inv?.aoi ?? null,
        originZone: origin.data?.origin?.originField?.support90 ?? null,
        originDegraded: origin.data?.origin?.status === 'DEGRADED',
        detections: (detections.data?.items ?? []) as Detection[],
        tracks: tracks.data?.items ?? [],
        vesselPositions: vessels,
        highlightMmsi,
        hoveredMmsi,
        visible: Object.fromEntries(Object.entries(layerVisible).map(([k, v]) => [k, v.visible])),
        opacity: Object.fromEntries(Object.entries(layerVisible).map(([k, v]) => [k, v.opacity])),
      }),
    [
      inv,
      detections.data,
      tracks.data,
      origin.data,
      vessels,
      highlightMmsi,
      hoveredMmsi,
      layerVisible,
    ],
  );

  if (isLoading) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  // A failed request must NOT render as a loading state. The previous branch was
  // `isLoading || !inv`, so an error — react-query sets `isLoading` false and leaves `data`
  // undefined — showed "Loading…" forever. The user waits on a request that already failed,
  // and the most common cause is the one they most need told: they do not have access to
  // this investigation.
  if (isError || !inv) {
    const status = (error as { status?: number } | null)?.status;
    const problem = (error as { problem?: { title?: string; detail?: string } } | null)?.problem;
    return (
      <main className="page">
        <h1>Investigation unavailable</h1>
        <p className="muted">
          {status === 403
            ? 'You do not have access to this investigation. Ask its lead to add you.'
            : status === 404
              ? 'No investigation with this ID exists, or it has been deleted.'
              : (problem?.detail ??
                problem?.title ??
                'The investigation could not be loaded. The API may be unreachable.')}
        </p>
        <p className="muted mono">
          {id}
          {status ? ` · HTTP ${status}` : ''}
        </p>
        <p>
          <Link to="/investigations">← Back to investigations</Link>
        </p>
      </main>
    );
  }

  const darkInZone = (tracks.data?.darkPeriods ?? []).filter((d) => d.overlapsOriginZone).length;

  return (
    <div className="workspace">
      <aside className="ws-rail">
        <h2 className="ws-title">{inv.name}</h2>
        <p className="muted mono ws-sub">
          {formatAreaKm2(inv.aoiAreaKm2)}
          <br />
          {formatUtc(inv.windowStart)}
          <br />→ {formatUtc(inv.windowEnd)}
        </p>

        <nav className="ws-tabs" role="tablist">
          {(
            [
              ['catalogue', 'Catalogue', null],
              ['scenes', 'Scenes & detections', detections.data?.items.length ?? null],
              ['origin', 'Origin', null],
              ['ais', 'AIS', coverage.data?.distinctVessels ?? null],
              ['candidates', 'Candidates', null],
              ['activity', 'Activity', null],
              ['team', 'Team & trail', null],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'ws-tab on' : 'ws-tab'}
              onClick={() => setTab(key as Tab)}
            >
              {label}
              {count != null ? <span className="badge">{count}</span> : null}
            </button>
          ))}
        </nav>

        <PipelineProgress
          investigationId={id!}
          onGoToTab={(t) => setTab(t as Tab)}
          state={{
            scenes: scenes.data?.items.length ?? 0,
            detections: detections.data?.items.length ?? 0,
            reviewed: (detections.data?.items ?? []).filter((d) => d.reviewStatus !== 'UNREVIEWED')
              .length,
            hasOrigin: Boolean(origin.data?.origin),
            originDegraded: origin.data?.origin?.status === 'DEGRADED',
            candidates: candidates.data?.items.length ?? 0,
            aisVessels: coverage.data?.distinctVessels ?? 0,
          }}
        />

        {/* The same switcher every sibling view shows, so the set is learnable rather than
            four different link rows. */}
        <InvestigationViews investigationId={id!} current="workspace" />

        <LayerStackControl />
      </aside>

      <div className="ws-map">
        <MapRoot
          layers={layers}
          sarTile={sarTiles.data ?? null}
          sarVisible={layerVisible['sar-raster']?.visible ?? true}
          sarOpacity={layerVisible['sar-raster']?.opacity ?? 1}
        >
          <div className="ws-scrubber">
            <TimeScrubber
              sceneTimes={(scenes.data?.items ?? []).map((s) => s.acquiredAt)}
              releaseWindow={origin.data?.origin?.releaseWindow ?? null}
            />
          </div>
        </MapRoot>
      </div>

      <section className="ws-panel" role="tabpanel">
        {tab === 'catalogue' ? (
          <CataloguePanel aoi={inv.aoi} from={inv.windowStart} to={inv.windowEnd} />
        ) : null}

        {tab === 'scenes' ? <DetectionsPanel investigationId={id!} /> : null}

        {tab === 'origin' ? (
          <OriginPanel
            investigationId={id!}
            origin={origin.data?.origin ?? null}
            originReason={origin.data?.reason}
          />
        ) : null}

        {tab === 'ais' ? (
          <div className="stack-sm">
            {/* Coverage FIRST — an attribution is only as good as the AIS beneath it. */}
            <section className="card">
              <h2>AIS coverage</h2>
              {coverage.isLoading ? (
                <p className="muted">Loading…</p>
              ) : (
                <>
                  <p className="assessment">{coverage.data?.assessment}</p>
                  <dl className="kv">
                    <dt>Positions</dt>
                    <dd className="mono">{coverage.data?.recordCount.toLocaleString()}</dd>
                    <dt>Vessels</dt>
                    <dd className="mono">{coverage.data?.distinctVessels}</dd>
                    <dt>Median interval</dt>
                    <dd className="mono">{coverage.data?.medianIntervalSec ?? '—'} s</dd>
                    <dt>Dark periods over origin</dt>
                    <dd className="mono">{darkInZone}</dd>
                  </dl>
                </>
              )}
            </section>

            <section className="card">
              <h2>Tracks</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>MMSI</th>
                    <th className="num">Fixes</th>
                    <th className="num">Gaps</th>
                    <th className="num">Outliers removed</th>
                  </tr>
                </thead>
                <tbody>
                  {(tracks.data?.items ?? []).slice(0, 25).map((t) => (
                    <tr
                      key={t.mmsi}
                      onMouseEnter={() =>
                        useSelectionStore.getState().hover({ kind: 'vessel', mmsi: t.mmsi })
                      }
                      onMouseLeave={() => useSelectionStore.getState().hover({ kind: 'none' })}
                    >
                      <td className="mono">{t.mmsi}</td>
                      <td className="num mono">{t.fixCount}</td>
                      <td className="num mono">{t.gapCount}</td>
                      <td className="num mono">{t.removedOutlierCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        ) : null}

        {tab === 'team' ? (
          <>
            <TeamPanel investigationId={id!} />
            {/* Notes sit with the team, not in a tab of their own: they are read alongside
                who did what, which is the question they answer. */}
            <CommentThread investigationId={id!} />
          </>
        ) : null}

        {tab === 'activity' ? (
          <section className="card">
            <h2>Job activity</h2>
            <p className="muted">
              Ingest, back-tracking and correlation run asynchronously. Failures show the provider’s
              own message, because that is what says whether to change the date, the area, or the
              provider.
            </p>
            <JobActivity investigationId={id!} />
          </section>
        ) : null}

        {tab === 'candidates' && detections.data?.items?.[0] ? (
          <details className="card sens-card">
            <summary>Weight sensitivity</summary>
            <SensitivityPanel investigationId={id!} detectionId={detections.data.items[0]._id} />
          </details>
        ) : null}

        {tab === 'candidates' ? <CandidateRanking investigationId={id!} /> : null}
      </section>
    </div>
  );
}
