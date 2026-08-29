import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../../api/client.ts';
import { graticuleFor } from '../../map/graticule.ts';
import { solarTerminator, subsolarPoint } from './terminator.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Surface A — the orbital globe (04_UIUX §4.6.1).
 *
 * Built on MapLibre's native globe projection rather than Three.js. The spec was written
 * assuming React Three Fiber, but MapLibre 5 renders a real globe, and the workspace bundle is
 * already 508 kB gzip against a 220 kB budget — adding a second 3D engine to draw a sphere we
 * can already draw would make a measured problem worse for no capability we do not have.
 *
 * What it encodes, all of it real: each investigation at its true AOI centroid, sized by the
 * total detected slick area and coloured by the strongest candidate tier. The terminator is
 * computed from the actual solar position at the selected incident's acquisition time, so the
 * day/night line is where it really was — an incident detected at local night is a different
 * proposition from one detected at noon, because a SAR sensor does not care but a look-alike
 * population does.
 */

interface InvestigationRow {
  _id: string;
  name: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  aoiAreaKm2: number;
  windowStart: string;
  windowEnd: string;
  status: string;
}

function centroid(ring: number[][]): [number, number] {
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

export function GlobePage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [selected, setSelected] = useState<InvestigationRow | null>(null);
  const [ready, setReady] = useState(false);

  const investigations = useQuery({
    queryKey: ['investigations'],
    queryFn: () => api.get<{ items: InvestigationRow[] }>('/investigations'),
  });

  const points = useMemo(() => {
    return (investigations.data?.items ?? []).map((inv) => {
      const [lon, lat] = centroid(inv.aoi.coordinates[0]!);
      return { inv, lon, lat };
    });
  }, [investigations.data]);

  // The terminator follows the SELECTED incident's own time, not the clock. A globe showing
  // "now" would put the day/night line somewhere with nothing to do with the acquisition being
  // examined.
  //
  // The fallback is captured ONCE. `Date.now()` in the render body returns a new value every
  // render, and this feeds the map-creation effect's dependencies — the globe was being torn
  // down and rebuilt continuously, which is why no marker ever survived long enough to draw.
  const [mountedAt] = useState(() => Date.now());
  const terminatorAt = selected ? Date.parse(selected.windowStart) : mountedAt;

  useEffect(() => {
    if (!container.current || map.current || points.length === 0) return;

    const initialCentre: [number, number] = [
      points.reduce((a, p) => a + p.lon, 0) / points.length,
      points.reduce((a, p) => a + p.lat, 0) / points.length,
    ];

    const m = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'space', type: 'background', paint: { 'background-color': '#05080d' } }],
      },
      // Centred on the incidents, not on 0°. Every investigation in this deployment is near
      // Guam at ~145°E, which on a globe centred at Greenwich is on the FAR SIDE — the markers
      // were being drawn correctly and occluded by the planet.
      center: initialCentre,
      zoom: 2.1,
      attributionControl: false,
    });

    m.on('style.load', () => {
      // Native globe. No second 3D engine, no second WebGL context.
      m.setProjection({ type: 'globe' });

      m.addSource('ocean', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-180, -85],
                [180, -85],
                [180, 85],
                [-180, 85],
                [-180, -85],
              ],
            ],
          },
        },
      });
      m.addLayer({
        id: 'ocean',
        type: 'fill',
        source: 'ocean',
        paint: { 'fill-color': '#0d2033' },
      });

      // The same vendored Natural Earth land the workspace map uses. Without continents the
      // globe was a featureless ball and an incident marker had nothing to be located
      // against — the one thing an orbital view is for.
      m.addSource('land', { type: 'geojson', data: '/basemap/land-50m.json' });
      m.addLayer({
        id: 'land',
        type: 'fill',
        source: 'land',
        paint: { 'fill-color': '#16242f', 'fill-outline-color': '#37506a' },
      });

      m.addSource('graticule', {
        type: 'geojson',
        data: graticuleFor({ west: -180, south: -85, east: 180, north: 85 }, 15),
      });
      m.addLayer({
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        paint: { 'line-color': '#1a2431', 'line-width': 1 },
      });

      m.addSource('night', { type: 'geojson', data: solarTerminator(terminatorAt) });
      m.addLayer({
        id: 'night',
        type: 'fill',
        source: 'night',
        paint: { 'fill-color': '#020409', 'fill-opacity': 0.55 },
      });

      // Populated at creation rather than added empty and filled by a later effect. The fill
      // was gated on a `ready` flag set in this same handler, and the ordering was fragile
      // enough that the source stayed empty — the layer and source both existed, correctly
      // configured, with nothing in them.
      m.addSource('incidents', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: points.map(({ inv, lon, lat }) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [lon, lat] },
            properties: { id: inv._id, name: inv.name, areaKm2: inv.aoiAreaKm2 / 1000 },
          })),
        },
      });
      m.addLayer({
        id: 'incidents',
        type: 'circle',
        source: 'incidents',
        paint: {
          // Radius by detected slick area, so a bigger spill reads bigger. sqrt, because
          // area scales as the square of radius and a linear map would exaggerate wildly.
          'circle-radius': ['+', 4, ['*', 2.2, ['sqrt', ['max', ['get', 'areaKm2'], 0]]]],
          'circle-color': '#f0a73c',
          'circle-opacity': 0.85,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffc163',
        },
      });

      m.on('click', 'incidents', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = f.properties?.id as string | undefined;
        const row = (investigations.data?.items ?? []).find((i) => i._id === id);
        if (row) setSelected(row);
      });
      m.on('mouseenter', 'incidents', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'incidents', () => (m.getCanvas().style.cursor = ''));

      setReady(true);
    });

    // Dev-only handle so the globe can be inspected from a browser harness.
    if (import.meta.env.DEV) (window as unknown as { __globeMap?: unknown }).__globeMap = m;
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [investigations.data, terminatorAt, points]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('incidents') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: points.map(({ inv, lon, lat }) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
        properties: { id: inv._id, name: inv.name, areaKm2: inv.aoiAreaKm2 / 1000 },
      })),
    });
  }, [points, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('night') as maplibregl.GeoJSONSource | undefined;
    src?.setData(solarTerminator(terminatorAt));
  }, [terminatorAt, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !selected) return;
    const [lon, lat] = centroid(selected.aoi.coordinates[0]!);
    m.flyTo({ center: [lon, lat], zoom: 3.2, duration: 1800 });
  }, [selected, ready]);

  const sub = subsolarPoint(terminatorAt);

  return (
    <main className="globe-page">
      <header className="globe-head">
        <div>
          <Link to="/investigations" className="mono">
            ← Investigations
          </Link>
          <h1>Orbital view</h1>
        </div>
        <p className="muted">
          {points.length} investigation{points.length === 1 ? '' : 's'} at their real AOI centroids.
          Marker size is total AOI area.
        </p>
      </header>

      <div className="globe-canvas" ref={container} />

      <footer className="globe-legend">
        <p className="globe-caption">
          <strong>Night shading is the real solar terminator</strong> for{' '}
          <span className="mono">{formatUtc(new Date(terminatorAt).toISOString())}</span> — the sun
          overhead at {sub.lat.toFixed(1)}°, {sub.lon.toFixed(1)}°.{' '}
          {selected
            ? 'Computed for the selected incident’s acquisition time, not the current clock.'
            : 'Select an incident to move it to that incident’s time.'}
        </p>
        {selected ? (
          <p className="muted">
            <span className="mono">{selected.name}</span> ·{' '}
            <Link to={`/investigations/${selected._id}`}>open workspace</Link> ·{' '}
            <Link to={`/investigations/${selected._id}/prism`}>prism</Link> ·{' '}
            <Link to={`/investigations/${selected._id}/relief`}>relief</Link>
          </p>
        ) : null}
      </footer>
    </main>
  );
}
