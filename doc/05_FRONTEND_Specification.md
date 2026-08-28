# 05 — Frontend Specification

**Product:** VARUNA
**Stack:** React 18 + TypeScript 5.5 + Vite 5 + MapLibre GL + deck.gl + react-three-fiber
**Document version:** 1.0

> Read [04_UIUX_Design_System.md](04_UIUX_Design_System.md) first. This document specifies
> *behaviour*: structure, state, data flow, and the exact function-level contract of every
> screen and component.

---

## 5.1 Project structure

```
apps/web/
├── index.html
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx                 # router + provider tree
│   │   ├── routes.tsx
│   │   ├── ErrorBoundary.tsx
│   │   └── providers/              # QueryClient, Socket, Theme, Auth, MapRoot
│   ├── api/
│   │   ├── client.ts               # fetch wrapper: credentials, problem+json, X-Request-Id
│   │   ├── generated/              # types generated from the server OpenAPI spec
│   │   └── hooks/                  # one file per module, TanStack Query hooks
│   ├── state/
│   │   ├── useMapStore.ts          # viewport, basemap, interaction mode
│   │   ├── useTimeStore.ts         # window, cursor, playback  (high frequency)
│   │   ├── useLayerStore.ts        # visibility, opacity, order
│   │   ├── useSelectionStore.ts    # selected detection / vessel / candidate / feature
│   │   └── useUiStore.ts           # panels, drawers, modals, theme
│   ├── map/
│   │   ├── MapRoot.tsx             # single persistent MapLibre instance
│   │   ├── DeckOverlay.tsx         # deck.gl MapboxOverlay in interleaved mode
│   │   ├── layers/                 # one factory per layer
│   │   ├── interactions/           # picking, hover, draw, keyboard mode
│   │   └── camera.ts               # flyToFeature, fitBounds, presets
│   ├── three/
│   │   ├── Globe/                  # landing + locator globe
│   │   ├── SlickRelief/            # terrain-exaggeration controls
│   │   └── Prism/                  # space-time cube
│   ├── features/
│   │   ├── auth/  investigations/  catalogue/  scenes/  detection/
│   │   ├── origin/  ais/  candidates/  evidence/  reports/  admin/
│   ├── design/
│   │   ├── tokens.css  tokens.ts  motion.ts
│   │   └── primitives/             # Button, Input, Drawer, ...
│   ├── components/                 # domain components (§4.8.2)
│   ├── lib/
│   │   ├── units.ts                # branded units
│   │   ├── format.ts               # coordinates, timestamps, areas
│   │   ├── geo.ts                  # Turf wrappers for client-side math
│   │   ├── provenance.ts           # guard + assertion
│   │   └── time.ts                 # UTC-only helpers
│   └── workers/
│       ├── aisDecoder.worker.ts    # binary AIS payload → typed arrays
│       └── geojsonSimplify.worker.ts
```

---

## 5.2 Type safety for geospatial values

The single largest source of silent geospatial bugs is coordinate-order and unit confusion.
We eliminate it at compile time.

```ts
// lib/units.ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Longitude      = Brand<number, 'Longitude'>;
export type Latitude       = Brand<number, 'Latitude'>;
export type Kilometres     = Brand<number, 'Kilometres'>;
export type Metres         = Brand<number, 'Metres'>;
export type SquareKm       = Brand<number, 'SquareKm'>;
export type Knots          = Brand<number, 'Knots'>;
export type DegreesTrue    = Brand<number, 'DegreesTrue'>;
export type UtcIso         = Brand<string, 'UtcIso'>;

export const lon = (n: number): Longitude => {
  if (n < -180 || n > 180) throw new RangeError(`Longitude out of range: ${n}`);
  return n as Longitude;
};
export const lat = (n: number): Latitude => {
  if (n < -90 || n > 90) throw new RangeError(`Latitude out of range: ${n}`);
  return n as Latitude;
};

/** GeoJSON order is ALWAYS [lon, lat]. This type makes the mistake unrepresentable. */
export type LonLat = readonly [Longitude, Latitude];
```

Rules enforced in review and by lint:
- No function accepts a bare `number` for a distance, area, speed or bearing.
- Any conversion between units happens in exactly one place (`lib/units.ts`).
- `LonLat` is the only accepted coordinate pair type; `[lat, lon]` cannot type-check.

---

## 5.3 State architecture

### 5.3.1 The split

| Kind of state | Owner | Why |
|---|---|---|
| Server data (investigations, detections, tracks, candidates) | **TanStack Query** | Caching, dedup, background refresh, optimistic updates |
| Map viewport | **Zustand** (`useMapStore`) | Changes at pointer rate; must not go through Query |
| Time cursor + playback | **Zustand + refs** (`useTimeStore`) | Changes at 60 Hz during playback — see §5.3.3 |
| Layer visibility/opacity/order | **Zustand** (`useLayerStore`) | Small, synchronous, persisted per investigation |
| Selection | **Zustand** (`useSelectionStore`) | Drives cross-panel highlighting |
| UI chrome (panels, modals) | **Zustand** (`useUiStore`) | Ephemeral |
| Form state | **React Hook Form** | Local, uncontrolled, fast |

### 5.3.2 Store contracts

```ts
// state/useTimeStore.ts
interface TimeState {
  windowStart: UtcIso;
  windowEnd: UtcIso;
  cursor: number;                       // epoch ms — the authoritative playhead
  playing: boolean;
  speed: 1 | 10 | 60 | 300;
  releaseWindow: { earliest: number; latest: number;
                   mostLikelyStart: number; mostLikelyEnd: number } | null;

  setWindow(start: UtcIso, end: UtcIso): void;
  setCursor(epochMs: number): void;     // clamped to the window
  play(): void;
  pause(): void;
  setSpeed(s: 1|10|60|300): void;
  stepToNextFix(mmsi?: number): void;   // jump to next real AIS fix
  stepToPrevFix(mmsi?: number): void;
}
```

```ts
// state/useSelectionStore.ts
type Selection =
  | { kind: 'none' }
  | { kind: 'detection';  id: string }
  | { kind: 'candidate';  id: string; mmsi: number }
  | { kind: 'vessel';     mmsi: number }
  | { kind: 'aisFix';     mmsi: number; at: UtcIso }
  | { kind: 'originCell'; lonLat: LonLat; at: UtcIso };

interface SelectionState {
  selection: Selection;
  hovered: Selection;
  select(s: Selection): void;
  hover(s: Selection): void;
  clear(): void;
}
```

Selection is the cross-cutting mechanism: selecting a candidate row highlights its track on
the map, filters the timeline, opens the evidence drawer, and moves the prism camera — all
by subscribing to one store.

### 5.3.3 The 60 Hz problem and its solution

Playing the timeline at 300× moves every vessel marker every frame. Routing that through
React state would re-render the entire tree 60 times a second.

**Solution — the animation channel:**

```ts
// state/timeChannel.ts
export const timeChannel = { cursor: 0 };   // plain mutable object, no React

// map/DeckOverlay.tsx
useEffect(() => {
  let raf = 0;
  const loop = (now: number) => {
    if (useTimeStore.getState().playing) {
      const { speed, windowEnd } = useTimeStore.getState();
      timeChannel.cursor = Math.min(timeChannel.cursor + (16.7 * speed), windowEnd);
      overlayRef.current?.setProps({
        layers: buildLayers({ ...layerInputs, cursor: timeChannel.cursor })
      });
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}, [layerInputs]);

// The React store is synced at 4 Hz only, for panels that display the time textually.
useEffect(() => {
  const id = setInterval(() => useTimeStore.getState().setCursor(timeChannel.cursor), 250);
  return () => clearInterval(id);
}, []);
```

React re-renders 4 times per second. deck.gl updates 60 times per second. This is the
single most important performance decision in the client.

---

## 5.4 The map subsystem

### 5.4.1 One map, forever

`MapRoot` mounts a single MapLibre instance at the app root and **never unmounts it**.
Route changes swap the panels around the map; the map itself persists. This eliminates the
tile re-fetch and camera reset that would otherwise happen on every navigation.

```tsx
// app/providers/MapRoot.tsx
const MapContext = createContext<maplibregl.Map | null>(null);

export function MapProvider({ children }: PropsWithChildren) {
  const ref = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    const m = new maplibregl.Map({
      container: ref.current!,
      style: DARK_STYLE,            // local style JSON, no mandatory token
      center: [72.8, 19.0], zoom: 6, pitch: 0, bearing: 0,
      maxPitch: 70, antialias: true, attributionControl: true,
    });
    m.on('load', () => setMap(m));
    return () => m.remove();
  }, []);

  return (
    <MapContext.Provider value={map}>
      <div ref={ref} className="map-root" />
      {map && children}
    </MapContext.Provider>
  );
}
```

### 5.4.2 deck.gl integration

deck.gl is attached as a `MapboxOverlay` in **interleaved** mode so 3D layers respect
MapLibre's depth buffer (essential for the Slick Relief terrain).

```tsx
const overlay = useMemo(() => new MapboxOverlay({
  interleaved: true,
  layers: [],
  getTooltip: null,               // we render our own hover card in the DOM
  onHover: handleHover,
  onClick: handleClick,
}), []);
```

### 5.4.3 Layer factory registry

Every layer is a pure function of inputs. No layer reads a store directly — this keeps
layers testable and prevents accidental re-renders.

```ts
// map/layers/index.ts
export interface LayerInputs {
  cursor: number;
  detections: SpillDetection[];
  tracks: VesselTrack[];
  candidates: CandidateVessel[];
  originFrames: OriginFrame[];
  selection: Selection;
  hovered: Selection;
  layerConfig: Record<LayerId, { visible: boolean; opacity: number }>;
  sceneTileUrl: string | null;
}

export function buildLayers(i: LayerInputs): Layer[] {
  return [
    sarRasterLayer(i),
    landMaskLayer(i),
    aoiLayer(i),
    originFieldLayer(i),
    driftParticleLayer(i),
    slickPolygonLayer(i),
    aisTrackLayer(i),
    vesselPositionLayer(i),
    candidateHighlightLayer(i),
    labelLayer(i),
  ].filter(Boolean) as Layer[];
}
```

### 5.4.4 Layer specifications

| Layer | deck.gl class | Key props | Notes |
|---|---|---|---|
| `sar-raster` | `TileLayer` + `BitmapLayer` | `data: ${TITILER}/cog/tiles/{z}/{x}/{y}?url=…&rescale=…` | Real COG, server-rendered. Rescale window is user-controlled. |
| `land-mask` | `GeoJsonLayer` | `filled`, `getFillColor: surface2` | From GSHHG/OSM coastline |
| `aoi` | `GeoJsonLayer` | `stroked`, dashed via `PathStyleExtension` | |
| `origin-field` | `BitmapLayer` per frame | Frame chosen by `cursor`; `opacity` ramp | Additive blending; only frames within ±1 step of cursor are mounted |
| `drift-particles` | `ScatterplotLayer` | `radiusMinPixels: 1`, typed-array `data` | 5,000 particles; positions supplied as `Float32Array` |
| `slick-polygon` | `GeoJsonLayer` | `getFillColor: oil500@0.22`, `getLineWidth: 2`, `lineWidthUnits:'pixels'` | Halo achieved by a second `PathLayer` beneath at width 4 in `--surface-0` |
| `ais-tracks` | `PathLayer` | binary `positions` + `startIndices`; `getColor` by categorical ramp | Dashed segments for gaps via a second layer with `PathStyleExtension` |
| `vessel-positions` | `IconLayer` | Heading triangle atlas; `getAngle: cog`; `getSize` by vessel length | Positions interpolated at `cursor` between real fixes (§5.4.5) |
| `candidate-highlight` | `PathLayer` | width 3, tier colour, `getWidth` boosted when selected | Non-candidates get `opacity 0.25` via a separate layer |
| `labels` | `TextLayer` | `getText: mmsi`, `fontFamily: 'IBM Plex Mono'`, collision via `CollisionFilterExtension` | |

### 5.4.5 Position interpolation — and its honesty guardrail

```ts
/**
 * Interpolate a vessel position at time t between real AIS fixes.
 * Returns null (vessel not rendered) when t falls inside a gap longer than maxGapMin,
 * because rendering a position there would be fabricating data.
 */
export function positionAt(
  track: VesselTrack, tMs: number, maxGapMin = 20
): { lonLat: LonLat; cog: DegreesTrue; interpolated: boolean } | null {
  const seg = findSegmentContaining(track, tMs);
  if (!seg) return null;

  const [a, b] = surroundingFixes(seg, tMs);
  if (!a) return null;
  if (!b) return { lonLat: a.lonLat, cog: a.cog, interpolated: false };

  const gapMin = (b.t - a.t) / 60000;
  if (gapMin > maxGapMin) return null;          // ← the guardrail

  const f = (tMs - a.t) / (b.t - a.t);
  return {
    lonLat: greatCircleInterpolate(a.lonLat, b.lonLat, f),
    cog: interpolateBearing(a.cog, b.cog, f),
    interpolated: f > 0 && f < 1,
  };
}
```

Interpolated markers render at **70% opacity with a hollow centre**; real fixes render
solid. The legend states the distinction. During a gap the vessel simply is not drawn and
its track is dashed — the absence is the information.

### 5.4.6 Picking and hover

- deck.gl `pickObject` on `pointermove`, throttled to 30 Hz.
- Hover writes to `useSelectionStore.hover` — a single small store write, not a layer rebuild.
- The hover card is a DOM element positioned absolutely, not a WebGL tooltip, so its
  typography matches the rest of the app and it is screen-reader reachable.

### 5.4.7 Keyboard map mode

Pressing `M` enters map keyboard mode (announced via live region):

| Key | Action |
|---|---|
| Arrows | Pan by 100 px |
| `+` / `-` | Zoom |
| `Tab` / `Shift+Tab` | Cycle features in the current layer |
| `[` / `]` | Cycle layers |
| `Enter` | Select focused feature |
| `Esc` | Exit map keyboard mode |

The focused feature is also announced and mirrored in the parallel accessible feature list.

---

## 5.5 Screens

### 5.5.1 Route map

| Route | Screen | Auth |
|---|---|---|
| `/` | Landing | public |
| `/login`, `/register` | Auth | public |
| `/investigations` | Investigation list | analyst+ |
| `/investigations/new` | Create wizard | analyst+ |
| `/investigations/:id` | **Workspace** (default: map) | member |
| `/investigations/:id/catalogue` | Scene search | member |
| `/investigations/:id/scenes/:sceneId` | Scene detail | member |
| `/investigations/:id/detections/:detId` | Detection review | member |
| `/investigations/:id/candidates` | Candidate ranking | member |
| `/investigations/:id/candidates/:candId` | Evidence detail | member |
| `/investigations/:id/prism` | Space-time prism | member |
| `/investigations/:id/report` | Report preview (also the PDF render target) | member |
| `/investigations/:id/jobs` | Job console | member |
| `/admin/*` | Users, quotas, providers, audit | admin |

### 5.5.2 Landing (`/`)

Composition per [04_UIUX §4.12](04_UIUX_Design_System.md). Behaviour:

- The globe is code-split (`React.lazy`) and only downloaded on this route.
- The scrollytelling strip uses GSAP `ScrollTrigger` with `pin: true`; each step advances a
  small static MapLibre instance to a real coordinate from the demo incident.
- The live Evidence Waterfall fetches `GET /api/v1/public/demo-incident` — a real, cached,
  publicly readable reconstruction. It is real data with real provenance, exposed
  read-only.
- All 3D and GSAP work is skipped entirely under `prefers-reduced-motion`, replaced by
  static frames.

### 5.5.3 Investigation list (`/investigations`)

| Element | Behaviour |
|---|---|
| Table | Virtualised (`@tanstack/react-virtual`); columns: name, AOI thumbnail, window (UTC), scenes, detections, top tier, updated |
| Filters | Status, date range, tier, owner — all reflected in the URL query string so views are shareable |
| Sort | Server-side, cursor paginated |
| Row click | Navigates to workspace; prefetch on hover via `queryClient.prefetchQuery` |
| Create | Opens the wizard |
| Empty state | "No investigations yet. Create one by drawing an area of interest and a date window." + primary action |

### 5.5.4 Create wizard (`/investigations/new`)

Four steps, each independently valid, state kept in the URL so refresh does not lose work.

1. **Identify** — name, description, incident reference (optional).
2. **Area of interest** — draw polygon / rectangle, or paste GeoJSON, or upload. Live area
   readout in km² (geodesic, computed with Turf). Blocks over 50,000 km² with an
   explanation.
3. **Time window** — UTC start/end, max 30 days, duration shown. Optional "known or
   reported incident time" field, which seeds the release-window prior.
4. **Review** — shows the AOI, the window, and a **live catalogue preview** ("14 Sentinel-1
   acquisitions intersect this AOI in this window") fetched before creation, so the user
   never creates an investigation with no possible data.

### 5.5.5 Workspace (`/investigations/:id`)

The primary screen. Layout per [04_UIUX §4.4.1](04_UIUX_Design_System.md).

**Left rail** — Overview · Catalogue · Scenes · Detections · Origin · AIS · Candidates ·
Prism · Report · Jobs. Each shows a count badge and a status dot.

**Map canvas** — persistent. Floating controls: layer stack (top-left), scale bar +
cursor coordinates in mono (bottom-right), camera presets, 3D toggle, basemap switch.

**Evidence panel (right, 400 px)** — content driven by the rail selection:

| Rail item | Panel content |
|---|---|
| Overview | Incident summary card, pipeline stage tracker, degradation banners, provenance summary |
| Catalogue | Scene search results with footprint hover-highlight on the map |
| Scenes | Ingested scenes; each with status, bands, preprocessing manifest link, "Run detection" |
| Detections | Detection list with area, confidence, review status; select to fly to |
| Origin | Origin estimate card: method, forcing sources, release window, parameters, "Re-run with different horizon" |
| AIS | Import panel + vessel list with quality strips |
| Candidates | The ranked list (§5.5.7) |
| Report | Section checklist + generate |
| Jobs | Live job console |

**Timeline (bottom, 120 px)** — per [04_UIUX §4.7.4](04_UIUX_Design_System.md).

**Keyboard shortcuts:** `⌘\` toggle panel · `⌘K` command palette · `Space` play/pause ·
`←/→` step by fix · `1–9` toggle layer *n* · `M` map keyboard mode · `?` shortcut help.

### 5.5.6 Detection review (`/investigations/:id/detections/:detId`)

| Element | Behaviour |
|---|---|
| Header | Area (km², geodesic), confidence breakdown, model name + version + artefact hash (mono) |
| Confidence panel | Four bars: mean oil probability, look-alike competition, wind suitability, morphology plausibility — each with its raw value and a `<MethodologyNote>` |
| Probability overlay | Slider blends the class map with the per-class probability raster so the analyst sees model uncertainty spatially |
| Morphology | Major/minor axis, elongation, orientation bearing — with the axis drawn on the map |
| Review actions | `Confirm` · `Reject` (requires reason) · `Edit geometry` (opens draw tools) |
| Edit behaviour | Creates a **new version**; the original model output stays immutable and both are listed in the review history |
| Comparator | `<ImageryComparator>` against the previous acquisition over the same footprint, if one exists |

### 5.5.7 Candidate ranking (`/investigations/:id/candidates`)

```
┌─ CANDIDATE VESSELS ───────────────────── 7 of 34 scored ──┐
│ [ Weights ▾ ]  [ Show excluded ]  [ Export CSV ]          │
├───────────────────────────────────────────────────────────┤
│ 1  ●  431907xxx   MT SEA PIONEER          71 ±6  MODERATE │
│       Tanker · 183 m · Panama                             │
│       2.4 km from origin · −41 min · dark 62 min          │
│       ▸ evidence                                          │
├───────────────────────────────────────────────────────────┤
│ 2  ●  244131xxx   BULK ATLANTIC           58 ±9  MODERATE │
│ ...                                                       │
├───────────────────────────────────────────────────────────┤
│ 5  ○  538006xxx   (name unavailable)      22    INSUFF.   │
└───────────────────────────────────────────────────────────┘
```

Behaviour:
- Row hover → track highlights on the map, all others fade to 0.25.
- Row click → expands the `<EvidenceWaterfall>` inline **and** flies the camera to fit the
  track plus the origin support polygon.
- `Weights ▾` opens the weight editor: 12 sliders summing to 100, live re-ranking with FLIP
  reordering, a `Reset to default profile` action, and a permanent note that the modified
  profile will be recorded in the report.
- Excluded vessels are hidden by default but the count is always shown — never silently
  dropped.
- If the top tier is `INSUFFICIENT_EVIDENCE`, the list is preceded by a full-width panel
  explaining why (too few measured features, degenerate spread, or no AIS coverage) rather
  than presenting a misleading ranking.

### 5.5.8 Evidence detail (`/investigations/:id/candidates/:candId`)

Three-column layout inside the workspace:

1. **Vessel identity** — `<VesselIdentityCard>`, static AIS data, flag from MID prefix,
   dimensions, quality flags with explanations.
2. **Evidence waterfall** — every feature row expandable to show: the definition, the
   normalisation curve with this vessel's value marked, the raw computation, and the
   source records.
3. **Source records** — the actual AIS fixes used, in a mono table: `t`, `lat`, `lon`,
   `sog`, `cog`, `navStatus`, `source`. Clicking a row moves the time cursor to that
   instant and flies the map there.

### 5.5.9 Space-time prism (`/investigations/:id/prism`)

Per [04_UIUX §4.6.3](04_UIUX_Design_System.md). Controls: time-axis scale, which origin
frames to show, candidate filter, camera presets (Plan / Elevation / Isometric), and a
`Sync with map` toggle.

### 5.5.10 Report preview (`/investigations/:id/report`)

- Renders the exact DOM that Playwright converts to PDF, in light theme, at A4 width.
- Section checklist on the left; each section can be included or excluded, but
  **Uncertainty & Limitations** and **Data Provenance** cannot be deselected.
- `Generate PDF` enqueues the report job; progress via WebSocket; download when complete.
- Additional exports: GeoJSON bundle, candidates CSV, run manifest JSON.

---

## 5.6 Data fetching contracts

### 5.6.1 The client wrapper

```ts
// api/client.ts
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
      ...init.headers,
    },
  });

  if (res.status === 401) { authStore.getState().onUnauthorised(); throw new AuthError(); }
  if (!res.ok) {
    const problem = await res.json().catch(() => null);   // RFC 9457
    throw new ApiError(problem?.title ?? res.statusText, problem);
  }
  if (res.status === 204) return undefined as T;

  const data = await res.json();
  assertProvenance(data);       // §5.7 — throws before the data can reach a component
  return data as T;
}
```

### 5.6.2 Query keys and cache policy

| Data | Key | `staleTime` | Invalidated by |
|---|---|---|---|
| Investigation | `['investigation', id]` | 30 s | any mutation on it |
| Catalogue search | `['catalogue', aoiHash, window, filters]` | 5 min | manual refresh only |
| Scenes | `['scenes', invId]` | 30 s | ingest job completion (WebSocket) |
| Detections | `['detections', invId]` | 30 s | detection job completion |
| Origin estimate | `['origin', detectionId]` | ∞ (immutable per run) | new run |
| Tracks | `['tracks', invId, windowHash]` | 5 min | AIS import completion |
| Candidates | `['candidates', invId, weightProfileId]` | ∞ | re-score |
| Jobs | `['jobs', invId]` | 5 s + WebSocket push | — |

**WebSocket-driven invalidation:** the socket provider maps job-completion events to
`queryClient.invalidateQueries`, so the UI updates without polling.

### 5.6.3 Binary transfer for AIS

AIS tracks are the largest payload. `GET /ais/tracks?format=binary` returns a compact
buffer:

```
[ uint32 trackCount ]
  per track: [ uint32 mmsi ][ uint32 pointCount ]
             [ float64 lon, float64 lat, float64 tMs, float32 sog, float32 cog ] × pointCount
```

Decoded in `aisDecoder.worker.ts` into `Float64Array` / `Float32Array` and handed to
deck.gl as binary attributes with zero per-point object allocation. This is the difference
between 250k points at 55 fps and 250k points at 6 fps.

---

## 5.7 Provenance enforcement in the client

```ts
// lib/provenance.ts
const PROVENANCE_REQUIRED = new Set([
  'SatelliteScene','SpillDetection','VesselTrack','OriginEstimate',
  'CandidateVessel','AisPosition',
]);

export function assertProvenance(data: unknown): void {
  forEachTypedObject(data, (obj, typeName) => {
    if (!PROVENANCE_REQUIRED.has(typeName)) return;
    const p = (obj as any).provenance;
    if (!p?.sourceType || !p?.provider || !p?.externalId || !p?.retrievedAt) {
      throw new ProvenanceError(`${typeName} ${(obj as any)._id} has no provenance`);
    }
  });
}
```

```tsx
// components/DataObject.tsx
export function DataObject({ value, typeName, children }: Props) {
  const ok = hasValidProvenance(value);
  if (!ok) {
    return (
      <div role="alert" className="provenance-missing">
        <strong>PROVENANCE MISSING</strong>
        <p>{typeName} cannot be displayed because it has no verifiable source record.</p>
        <code>{(value as any)?._id}</code>
      </div>
    );
  }
  return <>{children}</>;
}
```

Every data-bearing surface is wrapped. The failure state is intentionally ugly and
unmissable — a broken layout is a better outcome than an unsourced number.

---

## 5.8 Real-time integration

```ts
// app/providers/SocketProvider.tsx
socket.on('job:progress', ({ jobId, pct, stage, message }) => {
  useJobStore.getState().update(jobId, { pct, stage, message });
});

socket.on('job:completed', ({ jobId, kind, investigationId }) => {
  useJobStore.getState().complete(jobId);
  const map: Record<string, QueryKey[]> = {
    INGEST:     [['scenes', investigationId]],
    DETECTION:  [['detections', investigationId]],
    DRIFT:      [['origin', investigationId]],
    AIS_IMPORT: [['tracks', investigationId]],
    SCORING:    [['candidates', investigationId]],
    REPORT:     [['reports', investigationId]],
  };
  map[kind]?.forEach(k => queryClient.invalidateQueries({ queryKey: k }));
  toast.success(`${humanise(kind)} complete`);
});

socket.on('job:failed', ({ jobId, reason, detail }) => {
  useJobStore.getState().fail(jobId, reason);
  toast.error(reason, { detail, action: { label: 'Retry', onClick: () => retry(jobId) } });
});
```

Reconnection: exponential backoff, room re-join on connect, and a `stale` banner while
disconnected so the user knows the view may be behind.

---

## 5.9 Performance engineering checklist

| Technique | Where |
|---|---|
| Route-level code splitting | Every route; deck.gl, R3F, GSAP all lazy |
| Persistent map instance | `MapRoot` never unmounts |
| Binary AIS attributes | `aisDecoder.worker.ts` → deck.gl |
| Animation channel outside React | §5.3.3 |
| Virtualised lists | Investigation list, vessel list, AIS fix table |
| `useShallow` selectors on Zustand | Prevents whole-store re-renders |
| Memoised layer factories | `buildLayers` inputs are referentially stable |
| Server-side geometry simplification by zoom | `?simplify=z{zoom}` on track and polygon endpoints |
| `ETag` + `If-None-Match` | Immutable geometry endpoints |
| `content-visibility: auto` | Off-screen panel sections |
| Font subsetting + `font-display: swap` | Latin subset only; preconnect to Google Fonts |
| Image handling | Quicklooks as AVIF with WebP fallback; real rasters always via TiTiler, never inlined |

**Budgets** (enforced by `vite-bundle-visualizer` in CI): initial JS ≤ 280 kB gzip;
workspace route chunk ≤ 220 kB gzip; LCP ≤ 2.0 s; CLS ≤ 0.02; INP ≤ 200 ms.

---

## 5.10 Error handling

| Level | Handling |
|---|---|
| Route | `ErrorBoundary` per route with a recovery action; the map is preserved |
| Query | `TanStack Query` error state → inline panel error with retry, never a blank panel |
| Mutation | Toast with the server's `problem+json` `title` and `detail`; optimistic updates rolled back |
| WebGL context loss | Listener re-initialises the map and restores layer state from stores |
| Provenance failure | `<DataObject>` alert state (§5.7) |
| Unhandled | Sentry + a full-page fallback that preserves the investigation URL so nothing is lost |

---

## 5.11 Testing

| Level | Tool | Scope |
|---|---|---|
| Unit | Vitest | `lib/units`, `lib/geo`, `positionAt`, formatters, store reducers |
| Known-answer geodesy | Vitest | Client Turf results must match the server's pyproj results within 0.1% |
| Component | Testing Library | `EvidenceWaterfall`, `ConfidenceBadge`, `DataObject`, `TimeScrubber`, `AisQualityStrip` |
| Interaction | Testing Library + user-event | Weight editor re-ranking, exclusion flow, review flow |
| Visual regression | Playwright screenshots | Workspace, candidate list, evidence detail, report preview — light and dark |
| E2E | Playwright | The complete MVP journey against the real demo incident |
| Accessibility | axe-core in Playwright | Every route; zero critical/serious |
| Performance | Playwright tracing | Frame time with the 250k-point fixture (a real captured AIS slice) |

**Fixtures are real.** Every test fixture under `__fixtures__/real/` is a captured response
from a real provider with a sibling `.provenance.json`. No test uses invented vessels,
invented coordinates, or invented scores.
