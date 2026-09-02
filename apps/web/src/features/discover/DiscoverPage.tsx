import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { MapRoot } from '../../map/MapRoot.tsx';
import { buildLayers } from '../../map/layers.ts';
import { color, rgba } from '../../design/tokens.ts';
import { useMapStore } from '../../state/stores.ts';
import {
  useDiscoverRegions,
  useDiscoverDetections,
  useDiscoverOverpasses,
  useAdoptDetection,
  useTriggerSweep,
  useSweepJobs,
  type Detection,
  type DiscoverDetection,
  type DiscoverRegion,
} from '../../api/hooks.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';
import { ApiError } from '../../api/client.ts';
import { DiscoverTimeFilter, type Period } from './DiscoverTimeFilter.tsx';

/**
 * `/discover` — pick a time period, see what the sweep already found, start investigating
 * from there (06_BACKEND §6.4.10).
 *
 * Every other entry point into an investigation starts with the analyst describing an area
 * and a window from memory or a hunch. This one starts from evidence that already exists: a
 * small, named list of watch regions is swept on a schedule (see the module header in
 * `apps/api/src/modules/sweep/service.ts` for why it is a schedule and not a live search),
 * and this page browses what that sweep has already computed. Nothing here is a live query —
 * picking a period changes which ALREADY-FOUND detections are shown, instantly, rather than
 * commissioning new provider work.
 *
 * The map is the overview; the list is the interaction. Detection polygons are pickable in
 * the workspace map because a click there selects among a handful of results the analyst is
 * already deep in. Here the map's job is to show WHERE things are relative to the four watch
 * regions — the list of cards is where "Start investigating" actually lives, the same way
 * every other list of records in this app (scenes, candidates) is a list beside the map, not
 * a map click target.
 *
 * Two things are shown, not one. A DETECTION is VARUNA having found something. An OVERPASS is
 * a satellite having looked — far more common, and right now the only thing there is, because
 * the provider publishes these areas as raw products this pipeline cannot read. Showing only
 * detections would leave the page blank and imply a quiet sea; showing the overpasses too is
 * what makes "we looked, here is why we could not read it" visible instead of merely true.
 *
 * Only the SELECTED overpass's footprint is drawn. Eighty repeat passes over İskenderun are
 * eighty near-identical rectangles, and drawing them at once buries the detections under the
 * coverage.
 *
 * The camera follows the selection. `MapRoot` opens over Guam — a sensible default for the
 * one region with a staged end-to-end scene, and completely wrong here, where the whole point
 * is choosing among four regions on opposite sides of the planet. Picking a region that the
 * map then refuses to show reads as a broken map, so selection drives `fitBounds`: a region
 * frames that region, an overpass frames its footprint, and "All regions" pulls back far
 * enough to show every outline at once.
 */

const REGION_OUTLINE_COLOR = rgba(color.inkTertiary, 160);

/**
 * West, south, east, north of a polygon — the shorthand `fitBounds` speaks.
 *
 * Only the outer ring is measured. A hole cannot extend past the shape that contains it, so
 * for a bounding box the inner rings are noise.
 */
function bboxOfPolygon(
  geometry: { coordinates: number[][][] } | null | undefined,
): [number, number, number, number] | null {
  const ring = geometry?.coordinates?.[0];
  if (!ring?.length) return null;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** The smallest box containing every one of them. */
function unionBbox(
  boxes: [number, number, number, number][],
): [number, number, number, number] | null {
  if (boxes.length === 0) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

export function DiscoverPage() {
  const [period, setPeriod] = useState<Period | null>(null);
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  /** The one overpass whose footprint is drawn — see the header note on why not all of them. */
  const [selectedOverpass, setSelectedOverpass] = useState<string | null>(null);
  /** Only poll for sweep jobs once this page has actually asked for one. */
  const [watchingSweep, setWatchingSweep] = useState(false);
  /** Set by the empty state's "show me those" button; handed to the time filter to apply. */
  const [periodOverride, setPeriodOverride] = useState<Period | null>(null);
  const navigate = useNavigate();

  const regions = useDiscoverRegions();
  const detections = useDiscoverDetections(
    period?.from ?? '',
    period?.to ?? '',
    regionFilter ?? undefined,
  );
  const overpasses = useDiscoverOverpasses(
    period?.from ?? '',
    period?.to ?? '',
    regionFilter ?? undefined,
  );
  const adopt = useAdoptDetection();
  const triggerSweep = useTriggerSweep();
  const sweepJobs = useSweepJobs(watchingSweep);
  const fitBounds = useMapStore((s) => s.fitBounds);
  const mapReady = useMapStore((s) => s.ready);

  const activeSweep = (sweepJobs.data ?? []).find(
    (j) => j.status === 'QUEUED' || j.status === 'RUNNING',
  );
  const lastSweep = (sweepJobs.data ?? [])[0] ?? null;

  const regionLabel = useMemo(() => {
    const map = new Map((regions.data?.items ?? []).map((r) => [r.id, r.label]));
    return (id: string) => map.get(id) ?? id;
  }, [regions.data]);

  /**
   * What the last sweep of the currently-filtered region(s) actually saw — summed, because
   * "All regions" is the default and a per-region breakdown would bury the one fact the
   * empty state needs: whether anything flew over, and whether any of it was readable.
   */
  const sweepSummary = useMemo(() => {
    const inScope = (regions.data?.items ?? []).filter(
      (r) => !regionFilter || r.id === regionFilter,
    );
    const swept = inScope.filter((r) => r.status?.lastSweptAt).length;
    const sum = (pick: (s: NonNullable<(typeof inScope)[number]['status']>) => number | null) =>
      inScope.reduce((n, r) => n + (r.status ? (pick(r.status) ?? 0) : 0), 0);
    return {
      swept,
      overpassesSeen: sum((s) => s.overpassesSeen),
      ingestible: sum((s) => s.ingestible),
    };
  }, [regions.data, regionFilter]);

  /**
   * One line per region saying what its last sweep actually saw.
   *
   * A row showing only its own name gives no reason to prefer it over the other three. This
   * is the information that makes the choice an informed one, and it is already on the wire —
   * `/discover/regions` carries each region's last result.
   */
  function regionSummary(r: DiscoverRegion): string {
    if (r.status?.error) return 'Last sweep failed';
    if (!r.status?.lastSweptAt) return 'Not swept yet';
    const seen = r.status.overpassesSeen ?? 0;
    if (seen === 0) return 'No overpasses seen';
    return `${seen} seen · ${r.status.ingestible ?? 0} readable`;
  }

  const layers = useMemo<Layer[]>(() => {
    const items = detections.data?.items ?? [];
    // Only `.geometry`, `._id` and `.reviewStatus` are read by the slick-polygon layer
    // (`apps/web/src/map/layers.ts`) — every other `Detection` field belongs to a scene
    // being actively reviewed inside a workspace, which a Discover result has not entered
    // yet. Cast rather than fabricate placeholder values for fields nothing here reads.
    const slicks = buildLayers({
      aoi: null,
      originZone: null,
      detections: items as unknown as Detection[],
      tracks: [],
      vesselPositions: [],
      highlightMmsi: null,
      hoveredMmsi: null,
      visible: {},
      opacity: {},
    });

    // Watch-region outlines, built directly rather than through `buildLayers` — Discover is
    // the only view that needs them, and they say something no other layer does: where the
    // sweep looks at all. A thin, muted outline rather than dashed (no path-style extension
    // is a dependency of this app) still reads as "boundary," not "finding."
    const regionOutline = new GeoJsonLayer({
      id: 'watch-regions',
      data: (regions.data?.items ?? []).map((r) => ({
        type: 'Feature' as const,
        geometry: r.aoi,
        properties: { label: r.label },
      })),
      stroked: true,
      filled: false,
      getLineColor: REGION_OUTLINE_COLOR,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
    }) as unknown as Layer;

    /**
     * A pixel-sized dot per region, so the regions survive being zoomed out.
     *
     * "All regions" frames four boxes spread from the Gulf of Mexico to the Western Pacific,
     * which puts the camera at world zoom — where a region 40 km across is smaller than one
     * pixel and its outline disappears entirely. The map then claims to show every watch
     * region while showing none of them. A marker in PIXEL units does not shrink with the
     * scale, so each region stays findable at any zoom, and the outline takes over as the
     * honest depiction of its extent once you are close enough for that to mean something.
     */
    const regionMarkers = new ScatterplotLayer({
      id: 'watch-region-markers',
      data: (regions.data?.items ?? []).map((r) => ({
        id: r.id,
        // Centre of the bbox — a label anchor, not a claim about the region's shape, which
        // the outline alongside it already states exactly.
        position: [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2] as [number, number],
      })),
      getPosition: (d: { position: [number, number] }) => d.position,
      radiusUnits: 'pixels',
      getRadius: (d: { id: string }) => (d.id === regionFilter ? 8 : 6),
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      // Accent for every region, not only the selected one: all four ARE watched, and a
      // marker muted to near-invisibility says the opposite. Selection is carried by size and
      // fill weight instead, which stays legible against both the dark basemap and a bright
      // one without needing a second hue to mean "not chosen".
      getLineColor: (d: { id: string }) =>
        d.id === regionFilter ? rgba(color.accent400, 255) : rgba(color.accent400, 190),
      getFillColor: (d: { id: string }) =>
        d.id === regionFilter ? rgba(color.accent400, 150) : rgba(color.accent400, 45),
      updateTriggers: {
        getRadius: regionFilter,
        getLineColor: regionFilter,
        getFillColor: regionFilter,
      },
    }) as unknown as Layer;

    /**
     * The selected overpass alone. Its footprint is the swath the satellite actually covered,
     * which is much larger than any detection inside it — drawn as an outline so it frames
     * the detections rather than covering them.
     */
    const chosen = (overpasses.data?.items ?? []).find((o) => o._id === selectedOverpass);
    const overpassLayer =
      chosen?.footprint &&
      (new GeoJsonLayer({
        id: 'selected-overpass',
        data: [{ type: 'Feature' as const, geometry: chosen.footprint, properties: {} }],
        stroked: true,
        filled: false,
        getLineColor: rgba(color.accent400, 220),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
      }) as unknown as Layer);

    return overpassLayer
      ? [regionOutline, regionMarkers, overpassLayer, ...slicks]
      : [regionOutline, regionMarkers, ...slicks];
  }, [detections.data, regions.data, overpasses.data, selectedOverpass, regionFilter]);

  const selectedRegion = useMemo(
    () => (regions.data?.items ?? []).find((r) => r.id === regionFilter) ?? null,
    [regions.data, regionFilter],
  );

  /**
   * Frame whatever is selected.
   *
   * Keyed on `mapReady` rather than a timeout: the camera is registered by `MapRoot` during
   * its own load event, and calling `fitBounds` before that is a silent no-op — the store
   * holds a null impl and drops the call. Waiting on the flag the map itself sets is what
   * makes the first frame land instead of being swallowed.
   *
   * The selected overpass wins over the region because it is the narrower, later choice: an
   * analyst who clicks an acquisition wants to see the swath, not the region they were
   * already looking at.
   */
  useEffect(() => {
    if (!mapReady) return;

    const chosen = (overpasses.data?.items ?? []).find((o) => o._id === selectedOverpass);
    const overpassBox = chosen ? bboxOfPolygon(chosen.footprint) : null;
    if (overpassBox) {
      fitBounds(overpassBox);
      return;
    }

    if (selectedRegion) {
      fitBounds(selectedRegion.bbox);
      return;
    }

    // Results, if there are any, before the overview. Findings across all four regions still
    // cluster in one or two of them, and framing the whole planet to display fourteen slicks
    // a few hundred metres across shows the analyst nothing — the detections were being drawn
    // at sub-pixel size while the list beside them said fourteen.
    const found = unionBbox(
      (detections.data?.items ?? [])
        .map((d) => bboxOfPolygon(d.geometry))
        .filter((b): b is [number, number, number, number] => b !== null),
    );
    if (found) {
      // A slick is small enough that its own bounds would zoom past any useful context, so
      // the box is padded to roughly a region's worth of surroundings.
      const padLon = Math.max((found[2] - found[0]) * 0.6, 0.08);
      const padLat = Math.max((found[3] - found[1]) * 0.6, 0.08);
      fitBounds([found[0] - padLon, found[1] - padLat, found[2] + padLon, found[3] + padLat]);
      return;
    }

    // "All regions" with nothing found — pull back far enough to show every outline. The four
    // span the Gulf of Mexico to the Western Pacific, so this is legitimately close to a world
    // view; that is the honest picture of where the sweep looks, not a zoom chosen for looks.
    const all = unionBbox((regions.data?.items ?? []).map((r) => r.bbox));
    if (all) fitBounds(all);
  }, [
    mapReady,
    selectedRegion,
    selectedOverpass,
    overpasses.data,
    detections.data,
    regions.data,
    fitBounds,
  ]);

  const outsidePeriod = detections.data?.outsidePeriod ?? null;

  /**
   * Jump the period to the window where results actually are.
   *
   * The API's 90-day cap applies, so this asks for the 90 days ENDING at the most recent
   * finding rather than the full span between earliest and latest — which for data years
   * apart would be rejected outright. Landing on the newest results is the more useful half
   * anyway, and the dates are left visible in the custom picker for widening by hand.
   */
  function widenToResults() {
    if (!outsidePeriod?.latest) return;
    const to = new Date(outsidePeriod.latest);
    const earliest = outsidePeriod.earliest ? new Date(outsidePeriod.earliest) : to;
    const ninetyDaysBefore = new Date(to.getTime() - 89 * 86_400_000);
    const from = earliest > ninetyDaysBefore ? earliest : ninetyDaysBefore;
    setPeriodOverride({
      // A shade either side, so a finding exactly on the boundary is inside the window.
      from: new Date(from.getTime() - 3_600_000).toISOString(),
      to: new Date(to.getTime() + 3_600_000).toISOString(),
    });
  }

  function startSweep() {
    setSweepError(null);
    setWatchingSweep(true);
    triggerSweep.mutate(
      { regionId: regionFilter ?? undefined },
      {
        onError: (err) =>
          setSweepError(
            err instanceof ApiError
              ? (err.problem?.detail ?? err.problem?.title ?? err.message)
              : 'Could not start a sweep.',
          ),
      },
    );
  }

  function startInvestigating(d: DiscoverDetection) {
    setAdoptError(null);
    adopt.mutate(
      { id: d._id },
      {
        onSuccess: (result) => navigate(`/investigations/${result.investigationId}`),
        onError: (err) =>
          setAdoptError(
            err instanceof ApiError
              ? (err.problem?.detail ?? err.problem?.title ?? err.message)
              : 'Could not start an investigation from this.',
          ),
      },
    );
  }

  const items = detections.data?.items ?? [];

  return (
    <div className="discover">
      <aside className="discover-rail">
        <h1>Discover</h1>
        <p className="muted">
          A schedule sweeps {regions.data?.items.length ?? 'a handful of'} watch regions for new
          satellite imagery and runs detection automatically — pick a period to see what it has
          already found, and start a real investigation from any result.
        </p>

        <section className="discover-section">
          <h2 className="discover-section-title">Period</h2>
          <DiscoverTimeFilter onChange={setPeriod} override={periodOverride} />
        </section>

        <section className="discover-section">
          <h2 className="discover-section-title">Region</h2>
          <div className="discover-region-filter" role="group" aria-label="Filter by region">
            <button
              type="button"
              className={regionFilter === null ? 'discover-region on' : 'discover-region'}
              aria-pressed={regionFilter === null}
              onClick={() => setRegionFilter(null)}
            >
              <span className="discover-region-label">All regions</span>
              <span className="discover-region-meta">
                {regions.data?.items.length ?? 0} watched · the map frames all of them
              </span>
            </button>
            {(regions.data?.items ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                className={regionFilter === r.id ? 'discover-region on' : 'discover-region'}
                aria-pressed={regionFilter === r.id}
                onClick={() => setRegionFilter(r.id)}
              >
                <span className="discover-region-label">
                  {r.label}
                  {/* The one region with a real scene and real AIS already staged, so the full
                      chain runs end to end. Worth marking: it is the only row where a click
                      can currently lead anywhere. */}
                  {r.aisCoverage === 'STAGED' ? (
                    <span className="token token-ok">STAGED</span>
                  ) : null}
                </span>
                <span className="discover-region-meta">
                  {r.region} · {regionSummary(r)}
                </span>
              </button>
            ))}
          </div>
          {/* The note used to be a `title` tooltip, which is invisible on touch, invisible to
              keyboard users, and invisible to anyone not hovering the exact right box. It
              explains why the region is watched at all, so it is shown outright once chosen. */}
          {selectedRegion ? (
            <p className="field-hint discover-region-note">{selectedRegion.note}</p>
          ) : null}
        </section>

        {/* The manual trigger. Scoped to whatever region is selected, so pressing it while
            looking at one region costs one region's provider calls rather than four. */}
        <div className="discover-sweep">
          <button
            type="button"
            className="btn btn-primary"
            disabled={triggerSweep.isPending || Boolean(activeSweep)}
            onClick={startSweep}
          >
            {activeSweep
              ? 'Sweeping…'
              : triggerSweep.isPending
                ? 'Starting…'
                : regionFilter
                  ? 'Discover now in this region'
                  : 'Discover now'}
          </button>

          {activeSweep ? (
            <p className="field-hint" aria-live="polite">
              {activeSweep.progress?.stage ?? activeSweep.status}
              {typeof activeSweep.progress?.pct === 'number'
                ? ` · ${activeSweep.progress.pct}%`
                : ''}
              {activeSweep.progress?.message ? ` — ${activeSweep.progress.message}` : ''}
            </p>
          ) : lastSweep?.status === 'COMPLETED' ? (
            <p className="field-hint">Last sweep finished. Results below are up to date.</p>
          ) : lastSweep?.status === 'FAILED' ? (
            // Verbatim, never summarised — the reason is the analyst's next action.
            <p className="scene-read-warn">Last sweep failed: {lastSweep.failureReason}</p>
          ) : (
            <p className="field-hint">
              Runs automatically once a day. Press to check for new imagery right now.
            </p>
          )}

          {sweepError ? (
            <p className="form-error" role="alert">
              {sweepError}
            </p>
          ) : null}
        </div>

        {adoptError ? (
          <p className="form-error" role="alert">
            {adoptError}
          </p>
        ) : null}

        <div className="discover-results">
          {detections.isLoading ? (
            <p className="muted">Loading…</p>
          ) : items.length === 0 ? (
            <div className="empty-state">
              {/* "No DETECTIONS" — not "nothing found". The coverage list below may well be
                  full of real acquisitions, and a heading that says nothing was found while
                  72 of them sit underneath it is simply wrong. */}
              <h2>No detections in this period</h2>

              {/*
                When results exist just outside the window, that is the ONLY thing worth
                saying — every explanation below is about coverage, and none of them apply to
                a list emptied by the date picker. Reporting a bare zero here sent the reader
                looking for a fault in the pipeline when the fault was the period.
              */}
              {outsidePeriod && outsidePeriod.count > 0 ? (
                <>
                  <p>
                    <strong>
                      {outsidePeriod.count} detection{outsidePeriod.count === 1 ? '' : 's'}
                    </strong>{' '}
                    {outsidePeriod.count === 1 ? 'exists' : 'exist'} in{' '}
                    {regionFilter ? 'this region' : 'these regions'}, outside the period you picked
                    — {formatUtc(outsidePeriod.earliest!)}
                    {outsidePeriod.latest !== outsidePeriod.earliest
                      ? ` to ${formatUtc(outsidePeriod.latest!)}`
                      : ''}
                    .
                  </p>
                  <button type="button" className="btn" onClick={widenToResults}>
                    Show me those
                  </button>
                </>
              ) : null}
              {/* An empty map has two very different causes and only one of them is benign,
                  so the sweep's own last result is reported rather than left to be guessed.
                  "Quiet ocean" and "the imagery exists but we cannot read it" must not look
                  the same here. */}
              {outsidePeriod && outsidePeriod.count > 0 ? null : sweepSummary.swept === 0 ? (
                <p>
                  The sweep has not run over these regions yet. It runs daily; results appear here
                  once it has.
                </p>
              ) : sweepSummary.overpassesSeen === 0 ? (
                <p>
                  The last sweep found no satellite overpasses at all over these regions. Try a
                  longer period.
                </p>
              ) : sweepSummary.ingestible === 0 ? (
                <>
                  <p>
                    The last sweep saw{' '}
                    <strong>{sweepSummary.overpassesSeen} real satellite overpasses</strong> over
                    these regions — but none in a form VARUNA can read.
                  </p>
                  {/* The full explanation is stated once. When the coverage list is on screen
                      it carries the provider's own per-acquisition reason, so repeating the
                      paragraph here would say the same thing twice in one view. */}
                  {(overpasses.data?.items.length ?? 0) === 0 ? (
                    <p className="field-hint">
                      The provider is serving these as raw <span className="mono">GRD</span>, which
                      needs SNAP radiometric and terrain correction first. Detection runs on
                      terrain-corrected (<span className="mono">RTC</span>) products, and none are
                      currently published for these areas. This is a coverage limitation, not a
                      quiet sea — nothing was missed, and nothing here is being hidden from you.
                    </p>
                  ) : (
                    <p className="field-hint">
                      They are listed below, each with the provider&apos;s own reason.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  The last sweep found {sweepSummary.ingestible} readable scene(s), but no slick was
                  detected in them for this period.
                </p>
              )}
            </div>
          ) : (
            <>
              <h2 className="discover-section-title">
                {items.length} detection{items.length === 1 ? '' : 's'}
              </h2>
              <ul className="discover-card-list">
                {items.map((d) => (
                  <li className="discover-card" key={d._id}>
                    <div className="discover-card-head">
                      <span className="token">{regionLabel(d.regionId)}</span>
                      <span className="mono muted">{formatUtc(d.acquiredAt)}</span>
                    </div>
                    <dl className="discover-card-meta">
                      <dt>Area</dt>
                      <dd className="mono">{formatAreaKm2(d.areaKm2)}</dd>
                      <dt>Confidence</dt>
                      <dd className="mono">
                        {typeof d.confidence === 'object' && 'overall' in d.confidence
                          ? (d.confidence as { overall: number }).overall.toFixed(2)
                          : '—'}
                      </dd>
                    </dl>
                    <p className="field-hint mono discover-card-product">{d.productId}</p>
                    {/* A detection keeps matching its region after it has been adopted, because
                        Discover selects by place. Offering "Start investigating" again would
                        build a second investigation from the same scene, so an adopted finding
                        links to the case it already has instead. */}
                    {d.adopted ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => navigate(`/investigations/${d.investigationId}`)}
                      >
                        Open investigation
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={adopt.isPending}
                        onClick={() => startInvestigating(d)}
                      >
                        {adopt.isPending ? 'Starting…' : 'Start investigating'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/*
          Imagery coverage — what the sweep SAW, as distinct from what VARUNA found.
          Kept below the detections because a detection is the more actionable finding, but
          shown unconditionally: an overpass that produced nothing is the evidence that the
          sky was watched, and right now it is the only evidence there is.
        */}
        {(overpasses.data?.items.length ?? 0) > 0 ? (
          <div className="discover-coverage">
            <h2>Imagery over these regions</h2>
            <p className="field-hint">
              {overpasses.data!.items.length} acquisition
              {overpasses.data!.items.length === 1 ? '' : 's'} in this period.{' '}
              {overpasses.data!.items.filter((o) => o.ingestible).length} of them can be analysed.
              Select one to frame the area it covered on the map.
            </p>
            <ul className="discover-coverage-list">
              {overpasses.data!.items.map((o) => (
                <li
                  key={o._id}
                  className={`discover-overpass ${selectedOverpass === o._id ? 'on' : ''}`}
                >
                  <button
                    type="button"
                    className="discover-overpass-row"
                    aria-pressed={selectedOverpass === o._id}
                    onClick={() => setSelectedOverpass(selectedOverpass === o._id ? null : o._id)}
                  >
                    <span className="mono">{formatUtc(o.acquiredAt)}</span>
                    <span className="discover-overpass-tokens">
                      {selectedOverpass === o._id ? (
                        <span className="token token-accent">ON MAP</span>
                      ) : null}
                      <span className={o.ingestible ? 'token token-ok' : 'token token-warn'}>
                        {o.ingestible ? 'ANALYSABLE' : 'NOT READABLE'}
                      </span>
                    </span>
                  </button>
                  <p className="field-hint mono discover-overpass-meta">
                    {regionLabel(o.regionId)} · {o.platform ?? 'unknown platform'} · {o.collection}
                  </p>
                  {/* The provider's own words on why this cannot be used — the same text the
                      catalogue shows, not a paraphrase of it. */}
                  {!o.ingestible && o.ingestibleReason ? (
                    <p className="field-hint">{o.ingestibleReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>

      <div className="discover-map">
        <MapRoot layers={layers} />
      </div>
    </div>
  );
}
