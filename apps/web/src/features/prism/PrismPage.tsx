import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Breadcrumbs, InvestigationViews } from '../../components/Breadcrumbs.tsx';
import { useQuery } from '@tanstack/react-query';
import { Deck, OrbitView, COORDINATE_SYSTEM } from '@deck.gl/core';
import { PathLayer, PolygonLayer, ScatterplotLayer, LineLayer } from '@deck.gl/layers';
import { api } from '../../api/client.ts';
import { color, rgba } from '../../design/tokens.ts';
import { formatUtc } from '../../lib/format.ts';
import { makeProjector, findIntersections, intersectionsByVessel } from './geometry.ts';

/**
 * Surface C — the space-time prism (04_UIUX §4.6.3, route `/investigations/:id/prism`).
 *
 * Time is the vertical axis. A vessel track becomes a helix through the volume and the origin
 * estimate becomes a slab occupying the release window, so where a helix passes through the
 * slab the vessel was in the plausible release area during the plausible release period.
 *
 * That is the one thing a flat map cannot show. On a 2D plot, two vessels crossing the same
 * water twelve hours apart draw exactly the same picture; here one passes through the slab and
 * the other misses it entirely, at a visibly different height.
 *
 * ONE WebGL CONTEXT. This is a separate route, so the workspace map is unmounted while it is
 * open — the 3D budget of two contexts total (04 §4.6.4) is respected by never having both
 * alive at once, rather than by sharing one.
 */

interface TracksResponse {
  items: Array<{
    mmsi: number;
    line: { type: 'LineString'; coordinates: number[][] } | null;
    times?: number[];
  }>;
}

interface OriginResponse {
  reason: string;
  origin: {
    status: string;
    method: string;
    degradationReason: string | null;
    originField?: { support90?: { type: 'Polygon'; coordinates: number[][][] } };
    releaseWindow?: { earliest: string; latest: string; status: 'OK' | 'WIDE' };
  } | null;
}

interface Investigation {
  _id: string;
  name: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  windowStart: string;
  windowEnd: string;
}

interface OrbitState {
  target: [number, number, number];
  zoom: number;
  rotationX: number;
  rotationOrbit: number;
  minZoom?: number;
  maxZoom?: number;
}

const PRESETS = {
  isometric: { rotationX: 35, rotationOrbit: -25 },
  plan: { rotationX: 89, rotationOrbit: 0 },
  elevation: { rotationX: 2, rotationOrbit: 0 },
} as const;

function initialView(extentM: number): OrbitState {
  // OrbitView zoom is log2 of world-units-per-pixel scale, and the world here is METRES:
  // an AOI ~43 km across needs zoom near -6 to fit ~700 px. The first version added 8,
  // which put the camera inside the origin slab looking at its underside.
  const span = Math.max(extentM, 30_000);
  return {
    target: [0, 0, 15_000],
    zoom: Math.log2(900 / span),
    ...PRESETS.isometric,
    minZoom: -12,
    maxZoom: 4,
  };
}

export function PrismPage() {
  const { id } = useParams<{ id: string }>();
  const container = useRef<HTMLDivElement>(null);
  const deck = useRef<Deck<OrbitView> | null>(null);
  const [preset, setPreset] = useState<keyof typeof PRESETS>('isometric');
  const [view, setView] = useState<OrbitState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const inv = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api.get<Investigation>(`/investigations/${id}`),
    enabled: Boolean(id),
  });
  const tracks = useQuery({
    queryKey: ['ais-tracks', id],
    queryFn: () => api.get<TracksResponse>(`/investigations/${id}/ais/tracks?limit=60`),
    enabled: Boolean(id),
  });
  const origin = useQuery({
    queryKey: ['origin', id],
    queryFn: () => api.get<OriginResponse>(`/investigations/${id}/origin`),
    enabled: Boolean(id),
  });

  const model = useMemo(() => {
    if (!inv.data) return null;
    const ring = inv.data.aoi.coordinates[0]!;
    const lons = ring.map((c) => c[0]!);
    const lats = ring.map((c) => c[1]!);
    const bounds = {
      west: Math.min(...lons),
      south: Math.min(...lats),
      east: Math.max(...lons),
      north: Math.max(...lats),
    };
    const windowStart = Date.parse(inv.data.windowStart);
    const windowEnd = Date.parse(inv.data.windowEnd);
    const p = makeProjector(bounds, windowStart, windowEnd);

    const o = origin.data?.origin ?? null;
    const support = o?.originField?.support90?.coordinates?.[0] ?? null;
    const relEarliest = o?.releaseWindow ? Date.parse(o.releaseWindow.earliest) : null;
    const relLatest = o?.releaseWindow ? Date.parse(o.releaseWindow.latest) : null;

    const hits =
      support && relEarliest != null && relLatest != null
        ? findIntersections(tracks.data?.items ?? [], support, relEarliest, relLatest)
        : [];

    return {
      bounds,
      p,
      o,
      support,
      relEarliest,
      relLatest,
      hits,
      byVessel: intersectionsByVessel(hits),
    };
  }, [inv.data, tracks.data, origin.data]);

  useEffect(() => {
    if (!container.current || !model || deck.current) return;
    const { p, bounds, support } = model;
    // Frame the whole VOLUME, not just the AOI. A degraded origin slab is routinely larger
    // than the search area — here 80x81 km against 43x33 km — so fitting the AOI alone puts
    // the camera inside the slab looking at its underside.
    let [w, s] = p.toLocal(bounds.west, bounds.south);
    let [e, n] = p.toLocal(bounds.east, bounds.north);
    for (const c of support ?? []) {
      const [x, y] = p.toLocal(c[0]!, c[1]!);
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    const extent = Math.max(e - w, n - s);

    const startView = initialView(extent);
    setView(startView);
    deck.current = new Deck<OrbitView>({
      parent: container.current,
      views: new OrbitView({ orbitAxis: 'Z', fovy: 50 }),
      viewState: startView,
      controller: true,
      // Reduced motion needs no special case: the camera never auto-orbits, so it moves only
      // when the analyst moves it.
      onViewStateChange: ({ viewState }) => setView(viewState as OrbitState),
      layers: [],
    });

    return () => {
      deck.current?.finalize();
      deck.current = null;
    };
  }, [model]);

  useEffect(() => {
    if (!deck.current || !model) return;
    const { p, support, relEarliest, relLatest, hits } = model;

    const trackLayers = (tracks.data?.items ?? [])
      .filter((t) => t.line && t.times && t.times.length === t.line.coordinates.length)
      .map((t) => ({
        mmsi: t.mmsi,
        path: t.line!.coordinates.map((c, i) => {
          const [x, y] = p.toLocal(c[0]!, c[1]!);
          return [x, y, p.toZ(t.times![i]!)];
        }),
        hit: model.byVessel.has(t.mmsi),
      }));

    const layers = [
      // The origin slab: the release area, extruded through the release window. Drawn as two
      // faces rather than a solid so tracks inside remain visible.
      ...(support && relEarliest != null && relLatest != null
        ? [relEarliest, relLatest].map(
            (t, i) =>
              new PolygonLayer({
                id: `origin-slab-${i}`,
                coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
                data: [support],
                getPolygon: (ring: number[][]) =>
                  ring.map((c) => {
                    const [x, y] = p.toLocal(c[0]!, c[1]!);
                    return [x, y, p.toZ(t)];
                  }),
                filled: true,
                stroked: true,
                getFillColor: rgba(color.origin500, 40),
                getLineColor: rgba(color.origin700, 200),
                getLineWidth: 2,
                lineWidthUnits: 'pixels',
              }),
          )
        : []),

      new PathLayer({
        id: 'tracks',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: trackLayers,
        getPath: ((d: (typeof trackLayers)[number]) => d.path) as never,
        // A vessel that intersects the slab is drawn in the accent; everything else recedes.
        // The distinction is the finding, so it is the strongest signal on screen.
        getColor: (d: (typeof trackLayers)[number]) =>
          d.mmsi === selected
            ? rgba(color.accent400, 255)
            : d.hit
              ? rgba(color.oil500, 220)
              : rgba(color.inkTertiary, 70),
        getWidth: (d: (typeof trackLayers)[number]) => (d.hit ? 3 : 1.5),
        widthUnits: 'pixels',
        pickable: true,
        onClick: (info: { object?: { mmsi: number } }) => setSelected(info.object?.mmsi ?? null),
        updateTriggers: { getColor: [selected], getWidth: [selected] },
      }),

      new ScatterplotLayer({
        id: 'intersections',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: hits,
        getPosition: (d: (typeof hits)[number]) => {
          const [x, y] = p.toLocal(d.lon, d.lat);
          return [x, y, p.toZ(d.t)];
        },
        getFillColor: rgba(color.oil400, 255),
        getRadius: 4,
        radiusUnits: 'pixels',
        pickable: true,
      }),

      // A vertical leader from each intersection to the base plane, so its position on the
      // water can be read as well as its height in time.
      new LineLayer({
        id: 'leaders',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: hits,
        getSourcePosition: (d: (typeof hits)[number]) => {
          const [x, y] = p.toLocal(d.lon, d.lat);
          return [x, y, p.toZ(d.t)];
        },
        getTargetPosition: (d: (typeof hits)[number]) => {
          const [x, y] = p.toLocal(d.lon, d.lat);
          return [x, y, 0];
        },
        getColor: rgba(color.oil600, 90),
        getWidth: 1,
      }),
    ];

    deck.current.setProps({ layers });
  }, [model, tracks.data, selected]);

  // The camera is CONTROLLED from React state rather than read back out of Deck. A preset
  // then only has to change the angles and keep the analyst's current target and zoom, so
  // switching to Plan does not also throw away where they had panned to.
  useEffect(() => {
    setView((v) => (v ? { ...v, ...PRESETS[preset] } : v));
  }, [preset]);

  useEffect(() => {
    if (deck.current && view) deck.current.setProps({ viewState: view });
  }, [view]);

  if (inv.isLoading) return <main className="page">Loading…</main>;
  if (inv.isError || !inv.data || !model) {
    return (
      <main className="page">
        <h1>Prism unavailable</h1>
        <p className="muted">This investigation could not be loaded.</p>
        <Link to="/investigations">← Back</Link>
      </main>
    );
  }

  const o = model.o;
  const hitVessels = model.byVessel.size;

  return (
    <main className="prism-page">
      <header className="prism-head">
        <div>
          <Breadcrumbs
            items={[
              { label: 'Investigations', to: '/investigations' },
              { label: inv.data.name, to: `/investigations/${id}` },
              { label: 'Space–time prism' },
            ]}
          />
          <h1>Space–time prism</h1>
          <InvestigationViews investigationId={id!} current="prism" />
        </div>
        <nav className="prism-presets">
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((k) => (
            <button
              key={k}
              className={preset === k ? 'btn-download' : 'btn-ghost'}
              onClick={() => setPreset(k)}
            >
              {k}
            </button>
          ))}
        </nav>
      </header>

      <div className="prism-canvas" ref={container} />

      <footer className="prism-legend">
        {/* Non-dismissible. The vertical axis is TIME, and a viewer who reads it as altitude
            would misread every track on screen. */}
        <p className="prism-caption">
          <strong>Vertical axis is TIME, not height.</strong> The full column spans{' '}
          {formatUtc(inv.data.windowStart)} → {formatUtc(inv.data.windowEnd)}, at{' '}
          {(model.p.metresPerHour / 1000).toFixed(1)} km of column per hour. Horizontal distances
          are real metres.
        </p>
        {o ? (
          <p className="muted">
            The violet slab is the {o.method === 'FOOTPRINT_PROXIMITY' ? 'proximity' : 'drift'}{' '}
            release area between{' '}
            <span className="mono">{formatUtc(o.releaseWindow?.earliest ?? '')}</span> and{' '}
            <span className="mono">{formatUtc(o.releaseWindow?.latest ?? '')}</span>.{' '}
            {hitVessels === 0
              ? 'No vessel passed through it — no track was inside that area during that window.'
              : `${hitVessels} vessel${hitVessels === 1 ? '' : 's'} passed through it, drawn in amber.`}
            {o.status === 'DEGRADED' ? (
              <>
                {' '}
                The estimate is DEGRADED, so the slab is a proximity buffer rather than a
                back-tracked probability surface — passing through it is weaker evidence than it
                looks.
              </>
            ) : null}
          </p>
        ) : (
          <p className="muted">
            No origin estimate, so there is no release slab to intersect. Run back-tracking first —
            without it the prism shows where vessels were, but nothing to compare them against.
          </p>
        )}
        {selected ? <p className="mono">Selected MMSI {selected}</p> : null}
      </footer>
    </main>
  );
}
