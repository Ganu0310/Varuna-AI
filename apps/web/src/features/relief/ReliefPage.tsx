import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Breadcrumbs, InvestigationViews } from '../../components/Breadcrumbs.tsx';
import { useQuery } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../../api/client.ts';
import { DARK_STYLE } from '../../map/style.ts';

/**
 * Surface B — slick relief (04_UIUX §4.6.2, route `/investigations/:id/relief`).
 *
 * MapLibre reads elevation from Terrain-RGB tiles, so the same calibrated Sigma0 COG the
 * detector ran on can drive a 3D surface. A slick then appears as a basin, because oil damps
 * capillary waves and returns far less energy than the sea around it — which is easier to see
 * as terrain than as a grey patch.
 *
 * THE RELIEF IS BACKSCATTER, NOT HEIGHT. That is the whole hazard of this view. A viewer who
 * reads the basin as a depression in the sea surface has understood something false about the
 * physics, so the caption states it, states the current exaggeration, and cannot be dismissed
 * (04 §4.6.2 honesty guardrail, 12 F-28).
 *
 * Its own route, so the workspace map is unmounted while it is open — one WebGL context.
 */

interface SceneTiles {
  tileUrlTemplate: string;
  terrainUrlTemplate: string;
  bounds: [number, number, number, number] | null;
  minZoom: number;
  maxZoom: number;
}

interface Investigation {
  _id: string;
  name: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
}

interface Detection {
  _id: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  areaKm2: number;
}

const DEFAULT_EXAGGERATION = 12;

export function ReliefPage() {
  const { id } = useParams<{ id: string }>();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [exaggeration, setExaggeration] = useState(DEFAULT_EXAGGERATION);
  const [pitch, setPitch] = useState(55);
  const [ready, setReady] = useState(false);

  const inv = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api.get<Investigation>(`/investigations/${id}`),
    enabled: Boolean(id),
  });
  const scenes = useQuery({
    queryKey: ['scenes', id],
    queryFn: () =>
      api.get<{ items: Array<{ _id: string; status: string }> }>(`/investigations/${id}/scenes`),
    enabled: Boolean(id),
  });
  const detections = useQuery({
    queryKey: ['detections', id],
    queryFn: () => api.get<{ items: Detection[] }>(`/investigations/${id}/detections`),
    enabled: Boolean(id),
  });

  const readyScene = (scenes.data?.items ?? []).find((s) => s.status === 'READY');
  const tiles = useQuery({
    queryKey: ['scene-tiles', id, readyScene?._id],
    queryFn: () => api.get<SceneTiles>(`/investigations/${id}/scenes/${readyScene!._id}/tiles`),
    enabled: Boolean(id && readyScene?._id),
  });

  useEffect(() => {
    if (!container.current || map.current || !tiles.data || !inv.data) return;

    const ring = inv.data.aoi.coordinates[0]!;
    const lons = ring.map((c) => c[0]!);
    const lats = ring.map((c) => c[1]!);

    const m = new maplibregl.Map({
      container: container.current,
      style: DARK_STYLE,
      bounds: [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      pitch,
      attributionControl: false,
      maxPitch: 70,
    });

    m.on('load', () => {
      m.addSource('sar-image', {
        type: 'raster',
        tiles: [tiles.data.tileUrlTemplate],
        tileSize: 256,
        ...(tiles.data.bounds ? { bounds: tiles.data.bounds } : {}),
      });
      m.addLayer({ id: 'sar-image', type: 'raster', source: 'sar-image', paint: {} });

      m.addSource('sar-terrain', {
        type: 'raster-dem',
        tiles: [tiles.data.terrainUrlTemplate],
        tileSize: 256,
        // Mapbox packing, which is what TiTiler's `terrainrgb` algorithm emits.
        encoding: 'mapbox',
        ...(tiles.data.bounds ? { bounds: tiles.data.bounds } : {}),
      });
      m.setTerrain({ source: 'sar-terrain', exaggeration });

      const dets = detections.data?.items ?? [];
      if (dets.length > 0) {
        m.addSource('slicks', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: dets.map((d) => ({
              type: 'Feature' as const,
              geometry: d.geometry,
              properties: { areaKm2: d.areaKm2 },
            })),
          },
        });
        // Draped over the relief, in the same amber the 2D map uses, so a slick is the same
        // object in both views rather than two things that happen to look similar.
        m.addLayer({
          id: 'slicks-fill',
          type: 'fill',
          source: 'slicks',
          paint: { 'fill-color': '#f0a73c', 'fill-opacity': 0.25 },
        });
        m.addLayer({
          id: 'slicks-line',
          type: 'line',
          source: 'slicks',
          paint: { 'line-color': '#ffc163', 'line-width': 2 },
        });
      }
      setReady(true);
    });

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.current = m;

    return () => {
      m.remove();
      map.current = null;
    };
    // `exaggeration` and `pitch` are deliberately NOT dependencies. They are applied by the
    // two effects below, and including them here tore the whole map down and rebuilt it on
    // every tick of a slider — destroying and recreating a WebGL context per frame of a drag.
  }, [tiles.data, inv.data, detections.data]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    // 0 flattens it entirely, which is a legitimate thing to want: it is how you check that
    // a basin is really in the data rather than an artefact of the exaggeration.
    m.setTerrain(exaggeration === 0 ? null : { source: 'sar-terrain', exaggeration });
  }, [exaggeration, ready]);

  useEffect(() => {
    if (map.current && ready) map.current.setPitch(pitch);
  }, [pitch, ready]);

  if (inv.isLoading) return <main className="page">Loading…</main>;
  if (!readyScene && !scenes.isLoading) {
    return (
      <main className="page">
        <h1>No scene to render</h1>
        <p className="muted">
          Relief is built from an ingested Sentinel-1 raster. This investigation has none, so there
          is no backscatter surface to show. Ingest a scene first.
        </p>
        <Link to={`/investigations/${id}`}>← Back to the workspace</Link>
      </main>
    );
  }

  return (
    <main className="relief-page">
      <header className="relief-head">
        <div>
          <Breadcrumbs
            items={[
              { label: 'Investigations', to: '/investigations' },
              { label: inv.data?.name ?? 'investigation', to: `/investigations/${id}` },
              { label: 'Slick relief' },
            ]}
          />
          <h1>Slick relief</h1>
          <InvestigationViews investigationId={id!} current="relief" />
        </div>
        <div className="relief-controls">
          <label htmlFor="exag">
            Vertical exaggeration <span className="mono">{exaggeration}×</span>
          </label>
          <input
            id="exag"
            type="range"
            min={0}
            max={40}
            step={1}
            value={exaggeration}
            onChange={(e) => setExaggeration(Number(e.target.value))}
          />
          <label htmlFor="pitch">
            Pitch <span className="mono">{pitch}°</span>
          </label>
          <input
            id="pitch"
            type="range"
            min={0}
            max={70}
            step={1}
            value={pitch}
            onChange={(e) => setPitch(Number(e.target.value))}
          />
        </div>
      </header>

      <div className="relief-canvas" ref={container} />

      <footer className="relief-legend">
        {/*
          Non-dismissible, and it names the CURRENT exaggeration rather than a fixed number,
          because the figure on screen changes as the slider moves and a stale one would be
          worse than none.
        */}
        <p className="relief-caption">
          <strong>Vertical exaggeration {exaggeration}×</strong> — relief encodes SAR backscatter
          (σ⁰ dB), <strong>not sea-surface height</strong>. A slick appears as a basin because oil
          damps capillary waves and returns less energy, not because the sea is lower there.
        </p>
      </footer>
    </main>
  );
}
