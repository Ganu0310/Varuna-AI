import { Types } from 'mongoose';
import type { Polygon } from 'geojson';
import {
  DRIFT_DEFAULTS,
  MAX_AOI_KM2,
  WATCH_REGIONS,
  watchRegionAoi,
  type Role,
} from '@varuna/shared';
import { HttpError, NotFoundError } from '../../errors.js';
import { geodesicPolygonAreaKm2 } from '../../geo/geodesy.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { canAccessInvestigation } from '../../middleware/rbac.js';
import { audit } from '../audit/service.js';
import { createInvestigation } from '../investigations/service.js';
import { InvestigationModel, REAL_CASE_FILTER } from '../investigations/model.js';
import { SatelliteSceneModel } from '../scenes/model.js';
import { SpillDetectionModel } from '../detections/model.js';
import { SweepStateModel, SweepOverpassModel } from '../sweep/model.js';
import type { DiscoverDetectionsQuery } from './schema.js';

/**
 * Discover's read and adopt paths — 06_BACKEND §6.4.10.
 *
 * Deliberately its own module rather than folded into `admin`: `GET /admin/training-labels`
 * is the existing precedent for "reads deliberately cross investigation boundaries," but it
 * is `rbac('admin')`-gated, and Discover has to be usable by any analyst browsing for a case
 * to open — not only operators. So this crosses the boundary explicitly, on its own routes,
 * with the same audited-write discipline every other cross-cutting read in this codebase
 * follows, rather than borrowing admin's gate for a different audience.
 */

export interface WatchRegionStatus {
  lastSweptAt: string | null;
  overpassesSeen: number | null;
  ingestible: number | null;
  enqueued: number | null;
  error: string | null;
}

/**
 * The watch regions, each carrying what its last sweep actually saw.
 *
 * The status is the point. An empty Discover map has two completely different causes —
 * nothing flew over, or plenty flew over and none of it was in a form this pipeline can
 * read — and only the second is a problem an operator can act on. Reporting just the
 * detections would leave the UI saying "nothing found" for both.
 */
export async function listWatchRegions() {
  const states = await SweepStateModel.find({}).lean();
  const byRegion = new Map(states.map((s) => [s.regionId as string, s]));

  return WATCH_REGIONS.map((r) => {
    const s = byRegion.get(r.id);
    const last = s?.lastResult as
      | { overpassesSeen?: number; ingestible?: number; enqueued?: number; error?: string }
      | undefined;
    const status: WatchRegionStatus = {
      lastSweptAt: s?.lastSweptAt ? (s.lastSweptAt as Date).toISOString() : null,
      overpassesSeen: last?.overpassesSeen ?? null,
      ingestible: last?.ingestible ?? null,
      enqueued: last?.enqueued ?? null,
      error: last?.error ?? null,
    };
    return { ...r, aoi: watchRegionAoi(r), status };
  });
}

interface RawState {
  regionId: string;
  containerInvestigationId: Types.ObjectId;
}

export interface DiscoverDetection {
  _id: string;
  regionId: string;
  geometry: unknown;
  areaKm2: number;
  confidence: unknown;
  morphology: unknown;
  reviewStatus: string;
  sceneId: string;
  productId: string;
  acquiredAt: string;
  /** The investigation that currently owns the scene this detection sits on. */
  investigationId: string;
  /**
   * True when the scene lives in an ordinary investigation rather than a sweep container.
   *
   * Selecting by geography means an adopted detection keeps matching its region forever, so
   * without this the page would keep offering "Start investigating" on a finding that already
   * has an investigation, and a second press would build a duplicate. The distinction is a
   * fact about where the scene lives, so it is answered here rather than guessed at in the UI.
   */
  adopted: boolean;
}

/**
 * The investigations whose detections this user is allowed to see in Discover.
 *
 * Two sources, unioned. The SWEEP CONTAINERS are visible to every viewer - they are
 * system-owned, hold nothing a person authored, and being able to browse them is the whole
 * point of the feature. Everything else is the caller's OWN work, resolved by exactly the
 * rule `canAccessInvestigation` applies everywhere else: creator or member, never
 * soft-deleted. An admin sees every live investigation, which is already true of every other
 * admin read in this codebase.
 *
 * This is the part that has to be right. Discover selects detections by WHERE they are, and
 * a watch region is a public bounding box - so without this filter, asking for detections in
 * Iskenderun Bay would return every other analyst's private findings there. The geography
 * decides what is relevant; this decides what is permitted, and the query applies both.
 */
async function visibleInvestigationIds(
  user: { id: string; role: Role },
  containerIds: Types.ObjectId[],
): Promise<Types.ObjectId[]> {
  if (user.role === 'admin') {
    const all = await InvestigationModel.find({ deletedAt: null }).select({ _id: 1 }).lean();
    return all.map((i) => i._id as Types.ObjectId);
  }

  const uid = new Types.ObjectId(user.id);
  const own = await InvestigationModel.find({
    deletedAt: null,
    $or: [{ createdBy: uid }, { 'members.userId': uid }],
  })
    .select({ _id: 1 })
    .lean();

  const ids = new Map<string, Types.ObjectId>();
  for (const id of containerIds) ids.set(String(id), id);
  for (const i of own) ids.set(String(i._id), i._id as Types.ObjectId);
  return [...ids.values()];
}

/** Which watch region a point falls in, or null. First match wins - see `listDetections`. */
function regionAt(lon: number, lat: number, regions: typeof WATCH_REGIONS): string | null {
  const hit = regions.find(
    (r) => lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3],
  );
  return hit?.id ?? null;
}

/** Centre of a polygon's outer-ring bounding box - enough to say which region contains it. */
function polygonCentre(geometry: unknown): [number, number] | null {
  const ring = (geometry as { coordinates?: number[][][] } | null)?.coordinates?.[0];
  if (!ring?.length) return null;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

export interface DiscoverDetectionsResult {
  items: DiscoverDetection[];
  /**
   * Detections in these regions that the caller may see but which fall OUTSIDE the requested
   * window. Reported because a period control that silently hides every result is
   * indistinguishable from a system that found nothing - and those mean opposite things.
   */
  outsidePeriod: { count: number; earliest: string | null; latest: string | null };
}

/**
 * What VARUNA has found inside the watch regions - 06_BACKEND section 6.4.10.
 *
 * Selection is GEOGRAPHIC, not by ownership. This used to walk from each sweep state to its
 * container investigation and return only scenes ingested by the sweep itself, which made the
 * list permanently empty: the sweep cannot ingest anything while the provider publishes only
 * raw GRD for these areas, so every real detection this system holds lives in an ordinary
 * investigation and none of them were reachable. A region is a place, so "what have we found
 * in this place" is the question the page actually asks, and the answer should not depend on
 * which pipeline happened to put the scene there.
 *
 * Two filters, both mandatory: the geometry must fall inside a watch region, and the owning
 * investigation must be one the caller may read (`visibleInvestigationIds`). Broadening the
 * first without the second would turn a public bounding box into a way to read other people's
 * findings.
 *
 * Region assignment is a bbox test, which is exact here rather than an approximation: every
 * watch region AOI IS its bounding box (`watchRegionAoi` builds a rectangle from `bbox`), so
 * this agrees with the `$geoIntersects` filter by construction. Baniyas and Iskenderun overlap
 * slightly in longitude; a detection inside both is attributed to the first in
 * `WATCH_REGIONS` order, deterministically.
 */
export async function listDetections(
  q: DiscoverDetectionsQuery,
  user: { id: string; role: Role },
): Promise<DiscoverDetectionsResult> {
  const empty: DiscoverDetectionsResult = {
    items: [],
    outsidePeriod: { count: 0, earliest: null, latest: null },
  };

  const regions = q.regionId ? WATCH_REGIONS.filter((r) => r.id === q.regionId) : WATCH_REGIONS;
  if (regions.length === 0) return empty;

  const states = (await SweepStateModel.find(q.regionId ? { regionId: q.regionId } : {}, {
    regionId: 1,
    containerInvestigationId: 1,
  }).lean()) as unknown as RawState[];

  const investigationIds = await visibleInvestigationIds(
    user,
    states.map((s) => s.containerInvestigationId),
  );
  if (investigationIds.length === 0) return empty;

  // Deliberately NOT time-filtered. The same pass has to answer both "what is in this window"
  // and "is there anything outside it", and the scenes reachable through four small bounding
  // boxes are few enough that one read is cheaper than two.
  const scenes = await SatelliteSceneModel.find({
    investigationId: { $in: investigationIds },
    status: 'READY',
  })
    .select({ productId: 1, acquiredAt: 1, investigationId: 1 })
    .lean();
  if (scenes.length === 0) return empty;

  const sceneById = new Map(scenes.map((s) => [String(s._id), s]));
  const containerIdSet = new Set(states.map((st) => String(st.containerInvestigationId)));
  const detections = await SpillDetectionModel.find({
    sceneId: { $in: scenes.map((s) => s._id) },
    // Indexed (`geometry: '2dsphere'`), so the region test runs in the database rather than
    // by pulling every detection back and discarding most of them.
    $or: regions.map((r) => ({ geometry: { $geoIntersects: { $geometry: watchRegionAoi(r) } } })),
  }).lean();

  const from = new Date(q.from).getTime();
  const to = new Date(q.to).getTime();
  const items: DiscoverDetection[] = [];
  const outside: string[] = [];

  for (const d of detections) {
    const scene = sceneById.get(String(d.sceneId));
    if (!scene) continue;
    const centre = polygonCentre(d.geometry);
    if (!centre) continue;
    const regionId = regionAt(centre[0], centre[1], regions);
    if (!regionId) continue;

    const acquired = scene.acquiredAt as Date;
    const acquiredAt = acquired.toISOString();
    const t = acquired.getTime();
    if (t < from || t > to) {
      outside.push(acquiredAt);
      continue;
    }

    items.push({
      _id: String(d._id),
      regionId,
      geometry: d.geometry,
      areaKm2: d.areaKm2 as number,
      confidence: d.confidence,
      morphology: d.morphology,
      reviewStatus: d.reviewStatus as string,
      sceneId: String(scene._id),
      productId: scene.productId as string,
      acquiredAt,
      investigationId: String(scene.investigationId),
      adopted: !containerIdSet.has(String(scene.investigationId)),
    });
  }

  outside.sort();
  return {
    items: items.sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt)),
    outsidePeriod: {
      count: outside.length,
      earliest: outside[0] ?? null,
      latest: outside[outside.length - 1] ?? null,
    },
  };
}

export interface DiscoverOverpass {
  _id: string;
  regionId: string;
  productId: string;
  provider: string;
  collection: string;
  acquiredAt: string;
  platform: string | null;
  footprint: unknown;
  ingestible: boolean;
  ingestibleReason: string | null;
}

/**
 * Every acquisition the sweep saw over the watch regions in this window — readable or not.
 *
 * This is what makes an empty Discover map informative rather than blank. A detection is
 * VARUNA finding something; an overpass is a satellite having looked, which is a fact worth
 * showing on its own — especially now, when the provider publishes only raw products this
 * pipeline cannot read and every honest answer is "we saw the sky, we could not read it".
 */
export async function listOverpasses(q: DiscoverDetectionsQuery): Promise<DiscoverOverpass[]> {
  const rows = await SweepOverpassModel.find({
    ...(q.regionId ? { regionId: q.regionId } : {}),
    acquiredAt: { $gte: new Date(q.from), $lte: new Date(q.to) },
  })
    .sort({ acquiredAt: -1 })
    .limit(200)
    .lean();

  return rows.map((r) => ({
    _id: String(r._id),
    regionId: r.regionId as string,
    productId: r.productId as string,
    provider: r.provider as string,
    // Stored as `stacCollection` to dodge Mongoose's reserved `collection` path; the public
    // field keeps the name consumers expect.
    collection: r.stacCollection as string,
    acquiredAt: (r.acquiredAt as Date).toISOString(),
    platform: (r.platform as string | null) ?? null,
    footprint: r.footprint ?? null,
    ingestible: Boolean(r.ingestible),
    ingestibleReason: (r.ingestibleReason as string | null) ?? null,
  }));
}

/**
 * A scene's real footprint, cropped to sit within the investigation area cap.
 *
 * A full Sentinel-1 IW swath (up to ~250 km square) is bigger than the 50,000 km² cap, so
 * the honest first answer is often "shrink," the same problem the web upload path solves in
 * `apps/web/src/features/investigations/fromScene.ts::shrinkToLimit` — reimplemented here in
 * the API because the derivation for an adopted Discover scene has to run server-side, and
 * because the real geodesic routine (rather than that page's spherical approximation) is
 * available here.
 */
export function bboxOfFootprint(footprint: Polygon): [number, number, number, number] {
  const ring = footprint.coordinates[0]!;
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function bboxToPolygon([w, s, e, n]: [number, number, number, number]): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

export function shrinkToCap(
  bbox: [number, number, number, number],
): [number, number, number, number] {
  const areaOf = (b: [number, number, number, number]) =>
    geodesicPolygonAreaKm2(bboxToPolygon(b) as never) as number;
  if (areaOf(bbox) <= MAX_AOI_KM2) return bbox;

  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const halfLon = (e - w) / 2;
  const halfLat = (n - s) / 2;
  const at = (f: number): [number, number, number, number] => [
    cx - halfLon * f,
    cy - halfLat * f,
    cx + halfLon * f,
    cy + halfLat * f,
  ];

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (areaOf(at(mid)) > MAX_AOI_KM2) hi = mid;
    else lo = mid;
  }
  return at(lo * 0.999); // just inside the cap, not exactly on it
}

/** `DRIFT_DEFAULTS.horizonHours` before the acquisition — as far back as the back-track
 * model integrates by default, so AIS imported for the new investigation actually covers
 * what origin estimation will need — and 6 hours after, the same convention
 * `deriveScopeFromScene` uses on the web upload path. */
export function deriveScopeFromScene(scene: {
  footprint: Polygon;
  acquiredAt: Date;
  productId: string;
}): { aoi: Polygon; windowStart: Date; windowEnd: Date; name: string } {
  const bbox = shrinkToCap(bboxOfFootprint(scene.footprint));
  const acquired = scene.acquiredAt.getTime();
  return {
    aoi: rewindPolygon(bboxToPolygon(bbox) as never) as Polygon,
    windowStart: new Date(acquired - DRIFT_DEFAULTS.horizonHours * 3_600_000),
    windowEnd: new Date(acquired + 6 * 3_600_000),
    name: `${scene.productId} — ${scene.acquiredAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  };
}

export interface AdoptResult {
  investigationId: string;
  created: boolean;
  adoptedDetectionCount: number;
}

/**
 * Move a Discover-found scene — and every detection on it, not only the one clicked, so
 * siblings are never left orphaned in the sweep container — onto a real investigation.
 *
 * Creates a new investigation by default (the primary "start investigating" action); adopts
 * into an existing one instead when `targetInvestigationId` is supplied, guarding both the
 * caller's access to that investigation and the `{investigationId, productId}` unique index
 * a colliding productId would violate.
 */
export async function adoptDetection(
  detectionId: string,
  actor: { id: string; role: Role },
  targetInvestigationId: string | undefined,
  requestId?: string,
): Promise<AdoptResult> {
  const detection = await SpillDetectionModel.findById(detectionId);
  if (!detection) throw new NotFoundError('No such detection');

  const scene = await SatelliteSceneModel.findById(detection.sceneId);
  if (!scene) throw new NotFoundError('The scene behind this detection no longer exists');

  const state = await SweepStateModel.findOne({ containerInvestigationId: scene.investigationId });
  if (!state) {
    throw new HttpError(
      400,
      'Not a Discover detection',
      'This detection already belongs to a real investigation — open it there instead of ' +
        'adopting it.',
      'https://varuna.dev/problems/not-a-discover-detection',
    );
  }

  let investigationId: string;
  let created = false;

  if (targetInvestigationId) {
    const ok = await canAccessInvestigation(actor, targetInvestigationId, 'analyst');
    if (!ok) throw new NotFoundError('Investigation not found');
    // `canAccessInvestigation` bypasses membership for an admin caller, which would
    // otherwise let one admin re-parent a scene from one sweep container into ANOTHER
    // container by supplying its id — containers are not a valid adoption target.
    await assertRealInvestigation(targetInvestigationId);

    const collision = await SatelliteSceneModel.findOne({
      investigationId: new Types.ObjectId(targetInvestigationId),
      productId: scene.productId,
    }).lean();
    if (collision) {
      throw new HttpError(
        409,
        'Already adopted',
        `This scene (${scene.productId}) is already attached to that investigation.`,
        'https://varuna.dev/problems/scene-already-adopted',
      );
    }
    investigationId = targetInvestigationId;
  } else {
    const derived = deriveScopeFromScene({
      footprint: scene.footprint as unknown as Polygon,
      acquiredAt: scene.acquiredAt as Date,
      productId: scene.productId as string,
    });
    const inv = await createInvestigation(
      {
        name: derived.name,
        aoi: derived.aoi,
        windowStart: derived.windowStart.toISOString(),
        windowEnd: derived.windowEnd.toISOString(),
      } as never,
      actor,
      requestId,
    );
    investigationId = String(inv._id);
    created = true;
  }

  const targetOid = new Types.ObjectId(investigationId);
  await SatelliteSceneModel.updateOne({ _id: scene._id }, { $set: { investigationId: targetOid } });
  const { modifiedCount } = await SpillDetectionModel.updateMany(
    { sceneId: scene._id },
    { $set: { investigationId: targetOid } },
  );

  await audit({
    actorId: actor.id,
    action: 'DISCOVER_DETECTION_ADOPTED',
    entityType: 'Investigation',
    entityId: investigationId,
    after: {
      sceneId: String(scene._id),
      productId: scene.productId,
      fromContainer: String(scene.investigationId),
      detectionCount: modifiedCount,
      created,
    },
    requestId,
  });
  // The detach side of the same move, recorded against the container it left — so the
  // container's own audit trail shows where its scenes went, not just a silent shrink.
  await audit({
    actorId: actor.id,
    action: 'DISCOVER_DETECTION_DETACHED',
    entityType: 'Investigation',
    entityId: String(scene.investigationId),
    after: {
      sceneId: String(scene._id),
      productId: scene.productId,
      toInvestigation: investigationId,
    },
    requestId,
  });

  return { investigationId, created, adoptedDetectionCount: modifiedCount };
}

/** Used by the router to 404 rather than 500 if someone guesses an investigation id that
 * turns out to be a sweep container — containers are not addressable investigations. */
export async function assertRealInvestigation(id: string): Promise<void> {
  const doc = await InvestigationModel.findOne({ _id: id, ...REAL_CASE_FILTER }).lean();
  if (!doc) throw new NotFoundError('Investigation not found');
}
