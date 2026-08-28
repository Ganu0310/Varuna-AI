import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useInvestigation, useScenes, useDetections, type Detection } from '../../api/hooks.ts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { MapRoot } from '../../map/MapRoot.tsx';
import { buildLayers } from '../../map/layers.ts';
import { LayerStackControl } from '../../map/LayerStackControl.tsx';
import { TimeScrubber } from '../../components/TimeScrubber.tsx';
import { CandidateRanking } from '../candidates/CandidateRanking.tsx';
import { DetectionsPanel } from '../detections/DetectionsPanel.tsx';
import { CataloguePanel } from '../catalogue/CataloguePanel.tsx';
import { useLayerStore, useSelectionStore, useTimeStore, useMapStore } from '../../state/stores.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

type Tab = 'catalogue' | 'scenes' | 'ais' | 'candidates';

interface AisCoverage {
  recordCount: number;
  distinctVessels: number;
  medianIntervalSec: number | null;
  assessment: string;
}

interface TracksResponse {
  items: Array<{
    mmsi: number;
    line: { type: 'LineString'; coordinates: number[][] } | null;
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

  const { data: inv, isLoading } = useInvestigation(id);
  const scenes = useScenes(id);
  const detections = useDetections(id);
  const addLayer = useLayerStore((s) => s.addLayer);
  const layerVisible = useLayerStore((s) => s.layers);
  const setWindow = useTimeStore((s) => s.setWindow);
  const fitBounds = useMapStore((s) => s.fitBounds);
  const hovered = useSelectionStore((s) => s.hovered);
  const selected = useSelectionStore((s) => s.selected);

  const coverage = useQuery({
    queryKey: ['ais-coverage', id],
    queryFn: () => api.get<AisCoverage>(`/investigations/${id}/ais/coverage`),
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
    addLayer({
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
    });
  }, [inv, addLayer]);

  useEffect(() => {
    const scene = scenes.data?.items[0];
    if (!scene) return;
    addLayer({
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
    });
  }, [scenes.data, addLayer]);

  useEffect(() => {
    const d = detections.data?.items[0];
    if (!d) return;
    addLayer({
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
    });
  }, [detections.data, addLayer]);

  useEffect(() => {
    if (!tracks.data || tracks.data.items.length === 0) return;
    addLayer({
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
    });
  }, [tracks.data, addLayer]);

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

  const layers = useMemo(
    () =>
      buildLayers({
        sarTileUrl: null, // wired when a scene raster is selected
        sarBounds: null,
        aoi: inv?.aoi ?? null,
        originZone: null,
        detections: (detections.data?.items ?? []) as Detection[],
        tracks: tracks.data?.items ?? [],
        vesselPositions: [],
        highlightMmsi,
        hoveredMmsi,
        visible: Object.fromEntries(Object.entries(layerVisible).map(([k, v]) => [k, v.visible])),
        opacity: Object.fromEntries(Object.entries(layerVisible).map(([k, v]) => [k, v.opacity])),
      }),
    [inv, detections.data, tracks.data, highlightMmsi, hoveredMmsi, layerVisible],
  );

  if (isLoading || !inv) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
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
              ['ais', 'AIS', coverage.data?.distinctVessels ?? null],
              ['candidates', 'Candidates', null],
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

        <LayerStackControl />
      </aside>

      <div className="ws-map">
        <MapRoot layers={layers}>
          <div className="ws-scrubber">
            <TimeScrubber
              sceneTimes={(scenes.data?.items ?? []).map((s) => s.acquiredAt)}
              releaseWindow={null}
            />
          </div>
        </MapRoot>
      </div>

      <section className="ws-panel" role="tabpanel">
        {tab === 'catalogue' ? (
          <CataloguePanel aoi={inv.aoi} from={inv.windowStart} to={inv.windowEnd} />
        ) : null}

        {tab === 'scenes' ? <DetectionsPanel investigationId={id!} /> : null}

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

        {tab === 'candidates' ? <CandidateRanking investigationId={id!} /> : null}
      </section>
    </div>
  );
}
