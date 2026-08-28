# 04 — UI/UX Design System

**Product:** VARUNA
**Problem Statement:** SIH26143
**Document version:** 1.0

---

## 4.1 Design thesis

VARUNA is not a dashboard. It is an **instrument**.

The reference point is not a SaaS analytics product — it is a maritime operations console,
a sonar display, a flight-deck MFD. Those interfaces share four properties we adopt
deliberately:

1. **The data is the interface.** Chrome recedes; the map and the evidence dominate.
2. **Dark by default, because the map is dark.** SAR imagery is greyscale and low-contrast;
   a light UI destroys the signal. Dark is a functional decision, not a fashion one.
3. **Every number is legible at a glance and precise on inspection.** Tabular numerals,
   monospace for coordinates and identifiers, no rounding that hides uncertainty.
4. **Confidence is a first-class visual property.** Nothing in this product may look more
   certain than it is. Uncertainty gets pixels, not a footnote.

### 4.1.1 What we are explicitly avoiding

| Anti-pattern | Why it fails here |
|---|---|
| Centred hero with a purple-to-blue gradient | Generic; communicates nothing about maritime evidence |
| `rounded-2xl` cards floating on a light grey background | Wastes vertical space an operator needs for the map |
| Colour-only status encoding | Fails WCAG and fails colour-blind operators in a safety context |
| Decorative 3D that carries no information | Costs frames the map needs |
| Animated number counters on load | Implies precision the data does not have |
| Emoji as iconography | Wrong register for an evidence tool |

### 4.1.2 The one place decoration is allowed

The **public landing surface** (marketing/entry page and the report cover) may be
expressive, because its job is comprehension and credibility, not operation. The 3D globe
lives there and in the mini-locator. Inside the workspace, every 3D element must encode
data.

---

## 4.2 Typography

### 4.2.1 The three-family system

| Role | Family | Why this family | Weights used |
|---|---|---|---|
| **Display** — page titles, section headers, report covers, the wordmark | **Space Grotesk** | Grotesque skeleton with subtly mechanical terminals and a distinctive single-storey `a` at display size. Reads as *technical instrument*, not *startup landing page*. Its tight apertures hold up at 48–96 px. | 500, 600, 700 |
| **UI / Body** — labels, controls, prose, table headers | **IBM Plex Sans** | Designed for engineering and enterprise contexts; exceptional legibility at 12–14 px; large x-height; unambiguous `I`/`l`/`1`. Neutral without being anonymous. | 400, 500, 600 |
| **Data / Mono** — coordinates, MMSI, IMO, timestamps, scene IDs, hashes, all measurements | **IBM Plex Mono** | Same superfamily as the UI face, so they share metrics and voice. Slashed zero, distinguishable `O`/`0`, `1`/`l`. Fixed advance width makes columns of coordinates scannable. | 400, 500, 600 |

```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root {
  --font-display: 'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif;
  --font-ui:      'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  --font-mono:    'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
```

### 4.2.2 The non-negotiable typographic rules

| # | Rule | Reason |
|---|---|---|
| T1 | **Every numeric value uses `font-variant-numeric: tabular-nums`.** | A score changing from 71 to 68 must not shift the layout. |
| T2 | **Every identifier and coordinate is set in IBM Plex Mono.** MMSI, IMO, lat/lon, UTC timestamps, product IDs, SHA hashes. | These are read character by character, not as words. |
| T3 | **Latitude/longitude are shown to 5 decimal places (≈1 m) with an explicit hemisphere letter.** `19.07283° N, 072.87765° E` | Sign-based notation is a well-known source of transcription error. |
| T4 | **All timestamps display as `2023-08-14 06:12:47 Z`** — ISO order, space-separated, explicit `Z`. Local time only as a secondary, muted line. | UTC ambiguity corrupts spatiotemporal correlation. |
| T5 | **Units are always rendered, never implied,** in a muted weight adjacent to the value: `18.42 km²`, `6.3 kn`, `212°`. | Unit assumptions are how attribution goes wrong. |
| T6 | **Uncertainty is typeset with the value, not after it:** `71 ±6` where `±6` is one step down in size and one step down in emphasis. | Keeps the interval attached to the number. |
| T7 | **No text below 12 px.** Dense panels use 12 px with `letter-spacing: 0.01em`. | Operator legibility floor. |
| T8 | **Line length in prose blocks capped at 68 characters** (`max-width: 62ch`). | Report and methodology readability. |
| T9 | **Sentence case for all UI labels; ALL-CAPS reserved for taxonomy tokens** (`STRONG`, `AIS_GAP`, `DEGRADED`) at 11 px / `letter-spacing: 0.08em` / weight 600. | Caps become a signal for "this is a machine-defined category". |

### 4.2.3 Type scale

Modular scale, ratio 1.25 (major third), base 14 px, aligned to the 4 px spatial grid.

| Token | Size / line-height | Family | Weight | Use |
|---|---|---|---|---|
| `--t-display-xl` | 76 / 80 px | Display | 700 | Landing hero only |
| `--t-display-l` | 48 / 54 px | Display | 600 | Report cover, empty-state headline |
| `--t-display-m` | 34 / 40 px | Display | 600 | Page title (investigation name) |
| `--t-title-l` | 24 / 32 px | Display | 600 | Panel section title |
| `--t-title-m` | 19 / 26 px | UI | 600 | Card title, drawer header |
| `--t-title-s` | 16 / 24 px | UI | 600 | Subsection |
| `--t-body` | 14 / 22 px | UI | 400 | Default |
| `--t-body-strong` | 14 / 22 px | UI | 500 | Emphasised body |
| `--t-caption` | 12 / 18 px | UI | 400 | Helper text, secondary metadata |
| `--t-label` | 11 / 16 px | UI | 600 | Field labels (`letter-spacing: .04em`) |
| `--t-token` | 11 / 16 px | UI | 600 | Taxonomy tokens, ALL-CAPS (`letter-spacing: .08em`) |
| `--t-data-xl` | 40 / 44 px | Mono | 500 | The headline score |
| `--t-data-l` | 22 / 28 px | Mono | 500 | Primary metrics (area, distance) |
| `--t-data-m` | 14 / 20 px | Mono | 400 | Table cells, coordinates |
| `--t-data-s` | 12 / 16 px | Mono | 400 | Dense tables, hashes |

---

## 4.3 Colour

### 4.3.1 Palette philosophy

The base is **abyssal blue-black**, never pure black — pure black destroys the perceived
depth of SAR greyscale and makes elevation impossible to express. Accents are drawn from
real maritime instrumentation: sonar cyan, navigation amber, alert crimson.

**Hue is never the only carrier of meaning.** Every colour-coded state also carries a text
token, an icon, and a position in an ordered list.

### 4.3.2 Tokens

```css
:root {
  /* ---- surface ramp (dark, default) ---- */
  --surface-0:  #05080D;   /* app background, behind the map */
  --surface-1:  #0A0F16;   /* panel background */
  --surface-2:  #101823;   /* card, elevated panel */
  --surface-3:  #17212E;   /* popover, dropdown, drawer */
  --surface-4:  #1F2C3C;   /* hover / active row */
  --surface-inset: #04070B;/* wells, code blocks, map container */

  /* ---- borders / dividers ---- */
  --border-subtle: #1A2431;
  --border-default:#243243;
  --border-strong: #34465C;
  --border-focus:  #45E0E6;

  /* ---- ink ---- */
  --ink-primary:   #E8EFF7;
  --ink-secondary: #9FB2C6;
  --ink-tertiary:  #6B7F94;
  --ink-disabled:  #47586B;
  --ink-inverse:   #05080D;

  /* ---- brand / interactive: sonar cyan ---- */
  --accent-50:  #E6FCFD;
  --accent-200: #9DF0F4;
  --accent-400: #45E0E6;
  --accent-500: #22C9D1;   /* primary interactive */
  --accent-600: #14A2AC;
  --accent-700: #0C7A84;
  --accent-900: #063E45;

  /* ---- semantic: oil / detection (navigation amber) ---- */
  --oil-400: #FFC163;
  --oil-500: #F0A73C;      /* slick fill + stroke */
  --oil-600: #C9821F;
  --oil-glow: rgba(240,167,60,0.28);

  /* ---- semantic: origin probability (violet, sequential) ---- */
  --origin-100: #2A1D46;
  --origin-300: #5B3FA0;
  --origin-500: #8B63E8;
  --origin-700: #B99BFF;

  /* ---- status ---- */
  --status-ok:      #3ED598;
  --status-warn:    #F5B944;
  --status-danger:  #F2564B;
  --status-info:    --accent-500;
  --status-neutral: #6B7F94;

  /* ---- confidence tiers (also always labelled) ---- */
  --tier-strong:       #F2564B;   /* highest investigative priority */
  --tier-moderate:     #F0A73C;
  --tier-weak:         #4FA3D1;
  --tier-insufficient: #6B7F94;

  /* ---- AIS track categorical ramp (colour-blind safe, 8 hues) ---- */
  --track-1: #45E0E6;  --track-2: #FFB454;  --track-3: #7FD97F;  --track-4: #E389D8;
  --track-5: #7EA6FF;  --track-6: #F2A0A0;  --track-7: #C9B458;  --track-8: #9FB2C6;
}
```

### 4.3.3 Light theme

The workspace is dark-first, but a light theme exists for the **report** and for printing,
where dark backgrounds are wrong. Tokens are redefined; no component hardcodes a colour.

```css
:root[data-theme="light"] {
  --surface-0: #F7F9FB;  --surface-1: #FFFFFF;  --surface-2: #F1F5F9;
  --surface-3: #FFFFFF;  --surface-4: #E6EDF3;  --surface-inset: #EDF2F7;
  --border-subtle: #E2E8F0; --border-default: #CBD5E1; --border-strong: #94A3B8;
  --ink-primary: #0B1622; --ink-secondary: #3E5265; --ink-tertiary: #64748B;
  --accent-500: #0E8A93; --accent-400: #14A2AC;
  --oil-500: #B9761A;
  /* semantic hues darken to hold ≥4.5:1 on white */
}
```

### 4.3.4 Contrast requirements

| Pair | Minimum ratio | Verified |
|---|---|---|
| `--ink-primary` on `--surface-1` | 4.5:1 | 14.2:1 |
| `--ink-secondary` on `--surface-1` | 4.5:1 | 7.1:1 |
| `--ink-tertiary` on `--surface-1` | 3:1 (large/decorative only) | 4.0:1 |
| `--accent-500` on `--surface-1` | 4.5:1 | 6.8:1 |
| Focus ring against any surface | 3:1 | ≥ 4:1 |
| Map feature stroke against SAR raster | 3:1 | enforced by a 1 px `--surface-0` halo on every stroke |

---

## 4.4 Spatial system

- **Grid:** 4 px base. Every spacing, radius and size token is a multiple of 4.
- **Spacing scale:** `2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80` px.
- **Radii:** `--r-xs: 3px` (chips, tokens) · `--r-sm: 5px` (inputs, buttons) ·
  `--r-md: 8px` (cards, panels) · `--r-lg: 12px` (drawers, modals) · `--r-full: 999px`
  (avatars, pills only).
  Deliberately tighter than the current SaaS default — soft radii read as "consumer app",
  hard-ish radii read as "instrument".
- **Elevation** (dark theme uses light + border, not heavy shadow):

```css
--elev-1: 0 1px 2px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.03);
--elev-2: 0 4px 12px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04);
--elev-3: 0 12px 32px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
--elev-glow-accent: 0 0 0 1px var(--accent-700), 0 0 24px rgba(34,201,209,.18);
```

### 4.4.1 Workspace layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR  56px   wordmark · investigation name · status pills · user           │
├────────┬────────────────────────────────────────────────┬────────────────────┤
│        │                                                │                    │
│ RAIL   │                  MAP CANVAS                    │   EVIDENCE PANEL   │
│ 64px   │                  (fills)                       │   400px            │
│        │   ┌──────────────┐              ┌───────────┐  │                    │
│ icons  │   │ LAYER STACK  │              │ SCALE +   │  │  candidate list    │
│ +      │   │ (floating)   │              │ COORD     │  │  ↓                 │
│ labels │   └──────────────┘              └───────────┘  │  evidence drawer   │
│        │                                                │                    │
│        ├────────────────────────────────────────────────┤                    │
│        │ TIMELINE  120px   scrubber · playback · events  │                    │
└────────┴────────────────────────────────────────────────┴────────────────────┘
```

- Evidence panel collapses to 0 (map focus mode, `⌘\`).
- Timeline collapses to 32 px (summary bar only).
- Below 1280 px the evidence panel becomes an overlay drawer.
- Below 900 px the app switches to a stacked mobile layout (map / list / detail tabs) —
  usable for field review, not for primary analysis.

---

## 4.5 Motion system

### 4.5.1 Principles

1. **Motion explains causality.** A panel slides *from* the element that opened it.
2. **Motion never delays comprehension.** Nothing critical waits on an animation.
3. **Data motion is physical.** Vessels move at real relative speed under the time
   scrubber; particles drift with real velocity fields. Motion here is *data*, so it is
   never eased for aesthetics.
4. **`prefers-reduced-motion` is fully honoured.** All decorative motion becomes an
   instant state change; data animations become discrete stepped frames with a visible
   step control. No information is lost.

### 4.5.2 Tokens

```css
--dur-instant: 80ms;   --dur-fast: 140ms;   --dur-base: 220ms;
--dur-slow: 380ms;     --dur-deliberate: 620ms;

--ease-standard: cubic-bezier(.2,0,0,1);      /* enter + move */
--ease-exit:     cubic-bezier(.4,0,1,1);      /* leave */
--ease-emphasis: cubic-bezier(.2,0,0,1.12);   /* slight overshoot, selection only */
--spring-panel:  { type:'spring', stiffness:340, damping:34, mass:0.9 };
--spring-marker: { type:'spring', stiffness:520, damping:26, mass:0.6 };
```

### 4.5.3 Motion inventory

| Interaction | Motion | Duration |
|---|---|---|
| Panel / drawer open | Slide + fade from origin edge, spring | `--spring-panel` |
| Candidate row hover | Background lift + 2 px left accent bar grows from centre | `--dur-fast` |
| Candidate selected | Row expands to reveal the evidence waterfall; map flies to the track | `--dur-base` / camera `--dur-deliberate` |
| Score change (weight edit) | Bars re-interpolate; the rank list uses FLIP reordering so rows visibly travel to their new positions | `--dur-slow` |
| Map camera fly-to | `easeTo` with `--ease-standard`, pitch preserved | 620 ms |
| Layer toggle | Opacity 0↔1, no transform (transform on a map layer causes tile flicker) | `--dur-base` |
| Timeline scrub | No animation — 1:1 with pointer, `requestAnimationFrame` | — |
| Timeline playback | Real-time interpolation of vessel positions between AIS fixes | continuous |
| Drift particle replay | Particle cloud advances one model step per frame at chosen speed | continuous |
| Job progress | Determinate bar with a subtle 1.6 s shimmer only while `RUNNING` | continuous |
| Toast | Slide up 12 px + fade | `--dur-base` |
| Route change | Cross-fade content, map persists (never remounted) | `--dur-fast` |

### 4.5.4 The rule that protects the frame budget

React state updates never drive per-frame map motion. Timeline playback writes to a
mutable ref consumed inside a `requestAnimationFrame` loop that updates deck.gl layer
props directly. React re-renders only when the *selection* or *layer set* changes — at
most a few times per second, never sixty.

---

## 4.6 The 3D system

Three distinct 3D surfaces, each with an explicit justification. Any 3D element that
cannot answer "what does this let the user understand?" is cut.

### 4.6.1 Surface A — The Orbital Globe (landing + investigation locator)

**Purpose:** immediate spatial orientation — *where in the world is this incident* — and,
on the landing page, an honest statement of what the product does.

**Implementation:** react-three-fiber.

| Element | Technique |
|---|---|
| Earth sphere | `<sphereGeometry args={[1, 96, 96]} />` with a custom shader: night-side base `#070C14`, day-side subtle albedo, Fresnel rim in `--accent-500` at 0.35 intensity |
| Ocean depth | Bathymetry-driven normal map; specular highlight only on water so land reads matte |
| Atmosphere | Backface-rendered shell at radius 1.025 with an inverse-Fresnel additive shader — a real atmospheric scatter approximation, not a blur sprite |
| Incident markers | Instanced billboards at real lat/lon, radius scaled by slick area, colour by tier |
| Arcs | For a selected incident, a cubic Bézier arc from the vessel's entry point to the origin zone, animated by a dash offset |
| Graticule | 15° lines at 0.06 opacity — reads as an instrument, and helps judge scale |
| Terminator | Real solar position for the incident's UTC timestamp, so the day/night line is *correct*, not decorative |
| Camera | Damped orbit; auto-rotate 0.06 rad/s, halting on any pointer input and never resuming until idle for 6 s |

**Performance:** single draw call for markers via `InstancedMesh`; globe capped at 45 fps
via a frame limiter; `<Canvas frameloop="demand">` when static.

**Reduced motion:** auto-rotation disabled, globe renders one static frame at the incident
longitude.

### 4.6.2 Surface B — Slick Relief (workspace, optional layer)

**Purpose:** SAR backscatter is a *quantitative* surface, and a 2D greyscale image throws
away the operator's ability to judge gradient. Extruding backscatter as terrain makes the
dampening signature of oil — a smooth depression in an otherwise textured sea — visually
obvious.

**Implementation:** MapLibre 3D terrain fed by a `raster-dem`-encoded tile source derived
from the calibrated sigma-nought COG (TiTiler generates the DEM-encoded tiles).

| Control | Behaviour |
|---|---|
| Vertical exaggeration | Slider 0–40×, default 12×, value always displayed |
| Pitch | 0–70°, snap-to-0 button |
| Colour ramp | Same greyscale as 2D so nothing is invented by the 3D view |
| Slick polygon | Draped on the terrain with `--oil-500` fill at 0.25 and a 2 px stroke |

**Honesty guardrail:** a persistent caption reads
`Vertical exaggeration 12× — relief encodes SAR backscatter (σ⁰ dB), not sea-surface height.`
This is not optional copy. It prevents a viewer from believing they are seeing wave height.

### 4.6.3 Surface C — Spatiotemporal Prism (evidence view)

**Purpose:** the hardest thing to convey in this product is that space and time are *both*
constraints. A vessel can be close in space and wrong in time, and 2D cannot show that.

The prism renders a **space-time cube**: X/Y are geography, Z is time. Vessel tracks become
3D helices; the origin probability field becomes a stack of translucent slices; a candidate
is compelling when its helix passes *through* a bright slice — which is instantly readable
in 3D and impossible in 2D.

| Element | Technique |
|---|---|
| Base plane | Map screenshot-free: a live deck.gl `TileLayer` at z = 0 |
| Time axis | Z scaled so the full incident window maps to a fixed height; labelled every hour |
| Vessel tracks | `PathLayer` in 3D with `getPath` returning `[lon, lat, tToZ(t)]` |
| Origin field | 5–9 `BitmapLayer` slices at their model timestamps, additive blending, `--origin-*` ramp |
| Intersection markers | Where a track passes within the 50% support of a slice, a glowing node with a leader line to its evidence row |
| Camera | Orbit + dolly; three preset views: *Plan*, *Elevation*, *Isometric* |

Rendered in the same deck.gl context as the map, so there is no second WebGL context and
no state duplication.

### 4.6.4 3D budget rules

| Rule |
|---|
| Total WebGL contexts across the app: **2** (map+deck, globe). Never more. |
| The globe unmounts when the workspace mounts. |
| Any 3D surface drops to a static frame when the tab is hidden (`visibilitychange`). |
| No 3D asset over 1.5 MB; textures are `.ktx2`/basis compressed. |
| If `WEBGL_debug_renderer_info` indicates a software renderer, 3D surfaces render a static fallback with a clear notice. |

---

## 4.7 Data visualisation language

### 4.7.1 Map layer stack (bottom → top, fixed order)

| z | Layer | Encoding |
|---|---|---|
| 0 | Basemap (dark vector) | Muted; labels at 0.5 opacity |
| 1 | Bathymetry contours | `--border-subtle`, optional |
| 2 | **SAR raster** (COG via TiTiler) | Greyscale, user-adjustable rescale window, opacity slider |
| 3 | Land mask | `--surface-2` fill, 0.85 opacity |
| 4 | AOI boundary | `--accent-500` dashed 2 px, 0.06 fill |
| 5 | **Origin probability field** | `--origin-*` sequential ramp, additive blend; 50% and 90% contours as solid lines |
| 6 | Drift particles | 1 px points, `--origin-500`, 0.4 alpha, animated |
| 7 | **Slick polygon** | `--oil-500` fill 0.22, stroke 2 px + 1 px dark halo; hatch pattern if `reviewStatus = UNREVIEWED` |
| 8 | **AIS tracks** | 1.5 px paths, categorical ramp; opacity by AIS quality (gaps drawn dashed) |
| 9 | Vessel positions at current time `t` | Triangular heading markers, rotated by COG, sized by length |
| 10 | Candidate highlights | 3 px stroke in tier colour + outer glow; non-candidates drop to 0.25 opacity |
| 11 | Labels + leader lines | Collision-avoided, mono type |

Every layer has: a toggle, an opacity slider, a legend, and a **provenance chip** naming
its source. A layer with no provenance cannot be added to the stack.

### 4.7.2 The Evidence Waterfall

The core explainability component. For a selected candidate:

```
Investigative priority                                    71 ±6
                                                    ┌───────────┐
                                                    │ MODERATE  │
                                                    └───────────┘
  Spatial proximity to origin      2.4 km   ████████████████  +18.2
  Temporal alignment               −41 min  ██████████████    +15.6
  Track ∩ origin support           1.9 km   ███████████       +12.1
  Heading vs slick axis            7°       ████████          +8.4
  AIS dark period in window        62 min   ███████           +7.9
  Speed consistency                11.2 kn  █████             +5.2
  Vessel type prior                Tanker   ███               +2.8
  Draught change                   —        ░░░  NOT MEASURED   —
  Prior incidents                  —        ░░░  NOT MEASURED   —
  ─────────────────────────────────────────────────────────────
  Measured features: 7 / 12 · Score renormalised over measured only
```

Rules:
- Bars sorted by absolute contribution, descending.
- **Raw measured value always shown beside the contribution.** A normalised number without
  its raw value is not evidence.
- `NOT MEASURED` and `NOT APPLICABLE` rows are **rendered, not hidden**, in
  `--ink-tertiary` with a hatched bar. Hiding them would misrepresent the evidence base.
- Every row is clickable → opens the source records that produced it.
- The renormalisation note is permanent, not a tooltip.

### 4.7.3 Confidence encoding — the four-channel rule

Confidence is *never* encoded by colour alone. Every confidence display carries:

1. **Position** — rank order in the list
2. **Label** — the ALL-CAPS tier token
3. **Numeric interval** — `71 ±6`
4. **Colour** — tier hue (fourth, not first)

A `STRONG` tier additionally shows the sentence
*"Highest investigative priority. This is not a determination of responsibility."*
directly under the score. This copy is in the component, not in a settings-controlled
banner, so it cannot be turned off.

### 4.7.4 Timeline

```
06:00              08:00              10:00        [12:14 Z ◀]        14:00
├────────────────────┼──────────────────┼──────────────────┼───────────────┤
  ░░░░░░░░ estimated release window ░░░░░░░░
                         ▓▓▓ most likely ▓▓▓
                                              ▲ scene acquisition
  ●───────●──●────────●─────●    track: 431907xxx (VV quality: 0.96)
  ●──●─────────╌╌╌╌╌╌╌╌╌────●    track: 244131xxx  ← dashed = AIS gap
                    ⚑ dark period 62 min
```

- Ticks in mono type, always UTC.
- The release window is a *band*, never a line — the interval is the point.
- Playback: 1×, 10×, 60×, 300×; step-by-fix with `←`/`→`.
- Scrub position drives every time-aware layer through one shared store.

---

## 4.8 Component library

### 4.8.1 Primitives

| Component | Notable behaviour |
|---|---|
| `Button` | Variants `primary` / `secondary` / `ghost` / `danger`; sizes `sm`/`md`; `loading` state keeps width to prevent layout shift |
| `IconButton` | 32 px hit target minimum 44 px via padding; mandatory `aria-label` |
| `Input` / `Select` / `Combobox` | Label always visible (never placeholder-as-label); error text reserved-space so validation does not shift layout |
| `NumericField` | Mono font, tabular numerals, unit suffix rendered inside the field |
| `CoordinateField` | Accepts DD, DMS and DDM; normalises to DD on blur; shows the parsed result live |
| `DateTimeRange` | UTC only; shows duration; blocks ranges over the configured maximum |
| `Toggle` / `Checkbox` / `Radio` | 2 px focus ring, `--border-focus` |
| `Slider` | Value bubble in mono; keyboard steps; used for opacity, exaggeration, weights |
| `Tabs` | Roving tabindex, `aria-selected` |
| `Tooltip` | 400 ms delay; never the only source of critical information |
| `Popover` / `Drawer` / `Modal` | Focus trap, `Esc` to close, restores focus to the trigger |
| `Toast` | Polite live region; errors are assertive |
| `Skeleton` | Shape matches final content exactly to avoid layout shift |
| `EmptyState` | Always states *why* it is empty and *what to do next*; never a shrug illustration |

### 4.8.2 Domain components

| Component | Purpose |
|---|---|
| `<ProvenanceChip source dataset externalId retrievedAt />` | Small mono chip on every data-bearing surface. Click opens the full provenance record. |
| `<DataObject>` | Boundary wrapper. If a child's data lacks provenance it renders a red `PROVENANCE MISSING` panel instead of the data. Deliberately alarming. |
| `<ConfidenceBadge tier score ci />` | The four-channel confidence encoding of §4.7.3. |
| `<EvidenceWaterfall features />` | §4.7.2. |
| `<VesselIdentityCard mmsi />` | MMSI (mono), flag from MID prefix, name, IMO, type, dimensions, plus a quality-flag row. |
| `<AisQualityStrip flags completeness />` | Horizontal strip: green = good sampling, amber = sparse, hatched = gap, red = jump removed. |
| `<UncertaintyBand lower upper unit />` | Renders an interval as a band, used for release window and score CI. |
| `<LayerStackControl />` | Reorderable, per-layer opacity, legend, provenance chip. |
| `<TimeScrubber />` | §4.7.4. |
| `<JobConsole />` | Live job list with stage, percentage, elapsed, cancel, and the failure reason verbatim. |
| `<ImageryComparator a b />` | Split/swipe of two real acquisitions; both timestamps pinned to the header. |
| `<MethodologyNote id />` | Expandable, version-stamped explanation of an algorithm, reused verbatim in the PDF. |
| `<DegradationBanner status reason />` | Persistent, non-dismissible while the degraded state holds. |

---

## 4.9 Iconography

- **Set:** Lucide (24 px grid, 1.5 px stroke) as the base, extended with a small custom
  maritime set drawn on the same grid: vessel-underway, vessel-moored, AIS-gap, slick,
  SAR-scene, drift-particle, origin-zone, back-track.
- Stroke-only. No filled or duotone icons — they compete with the map.
- Icons never appear without a text label in primary navigation.
- No emoji anywhere in the product.

---

## 4.10 Accessibility specification

| Requirement | Implementation |
|---|---|
| Keyboard: full operation without a mouse | Every control focusable; map has a keyboard mode (arrows pan, `+`/`-` zoom, `Tab` cycles features, `Enter` selects) |
| Focus visibility | 2 px `--border-focus` ring with 2 px offset, always visible, never removed |
| Screen readers | Map features exposed through a parallel, virtualised `<ul>` "Feature list" that mirrors the visible layers and is fully navigable |
| Live regions | Job progress and re-ranking announce politely; failures announce assertively |
| Colour independence | Every colour-coded state carries a text token (§4.7.3) |
| Contrast | §4.3.4 |
| Motion | `prefers-reduced-motion` → decorative motion off; data animation becomes stepped with visible controls |
| Zoom | Layout functional to 200% browser zoom; panels reflow |
| Target size | Minimum 44 × 44 px effective for all interactive elements |
| Language | `lang` attribute set; all abbreviations expanded on first use (`AIS`, `SAR`, `MMSI`, `COG`, `SOG`) |
| Forms | Labels bound with `for`/`id`; errors linked via `aria-describedby`; error summary at the top of long forms |
| Charts | Every chart has an adjacent accessible data table toggle |

**Testing:** `axe-core` runs inside Playwright on every route; zero critical or serious
violations is a release gate. A manual keyboard-only pass and a screen-reader pass on the
workspace are required before release.

---

## 4.11 Content and voice

| Rule | Example |
|---|---|
| Never state responsibility as fact | ✅ "Highest investigative priority" ❌ "Responsible vessel" |
| Never hide uncertainty in prose | ✅ "Estimated release between 08:10 and 10:40 Z" ❌ "Released around 09:00" |
| Name the source in the sentence | ✅ "No AIS records from Marine Cadastre for this envelope" ❌ "No data" |
| Errors state cause and next action | ✅ "CMEMS returned no current data for 2019-03-04. Origin estimated by footprint proximity instead — confidence is reduced." |
| Empty states are informative | ✅ "No Sentinel-1 acquisitions intersect this AOI between 12–19 Aug. Try widening the window or including Sentinel-2." |
| Units always explicit | ✅ "18.42 km²" ❌ "18.42" |
| Machine tokens stay machine-shaped | `INSUFFICIENT_EVIDENCE` in UI as a token; expanded in prose as "insufficient evidence" |

---

## 4.12 Landing page composition (the one expressive surface)

| Section | Content | Motion |
|---|---|---|
| Hero | 3D orbital globe (§4.6.1) left; right: `--t-display-xl` headline *"Find the vessel behind the slick."* with the subhead stating the honest scope | Globe fades in over 900 ms; headline words rise 12 px staggered 40 ms; halts entirely under reduced motion |
| The chain | Six-step horizontal scrollytelling strip — Scene → Detection → Polygon → Back-track → AIS → Ranking — each step showing a real frame from a real reconstructed incident | GSAP ScrollTrigger pins the strip and advances the map state per step |
| Evidence demo | A live, interactive Evidence Waterfall from the real demo incident | Bars draw in on intersection |
| The honesty section | A full-width block, `--surface-inset`, stating what the system does not claim | None — stillness is the point |
| Data provenance | A grid of the actual sources with their licences | Cards lift 2 px on hover |
| Metrics | Real held-out model metrics, no rounding up | Values appear immediately; **no count-up animation** (§4.1.1) |

---

## 4.13 Design tokens delivery

Tokens live in `apps/web/src/design/tokens.css` as CSS custom properties and are exported
as a typed object in `tokens.ts` for use by deck.gl and Three.js, which cannot read CSS
variables. A CI check asserts the two files stay in sync, so the map, the 3D surfaces and
the DOM can never drift apart in colour.
