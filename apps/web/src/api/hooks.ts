import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@varuna/shared';
import { api } from './client.ts';

/**
 * TanStack Query hooks — query keys and cache policy per 05_FRONTEND §5.6.2.
 * More modules are added as their phases land.
 */
export interface PublicUser {
  _id: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt?: string;
}

/** Per-stage counts, so a list row can say WHERE a case got to, not merely that it exists. */
export interface StageCounts {
  scenes: number;
  detections: number;
  origins: number;
  candidates: number;
}

export interface Investigation {
  _id: string;
  name: string;
  description?: string;
  incidentReference?: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  aoiAreaKm2: number;
  windowStart: string;
  windowEnd: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Who may modify or delete this case. Sent by the API on both the list and the single
   * fetch, and used to decide whether to OFFER an action — a button that exists only to
   * return 403 teaches the user nothing except not to trust the buttons.
   */
  createdBy?: string;
  members?: Array<{ userId: string; role: Role }>;
  /** Present on list responses; absent when a single investigation is fetched. */
  counts?: StageCounts;
}

// ── auth ────────────────────────────────────────────────────────────
const meQuery = {
  queryKey: ['me'],
  queryFn: () => api.get<{ user: PublicUser; permissions: { role: Role } }>('/auth/me'),
  retry: false,
  staleTime: 30_000,
};

export function useMe() {
  return useQuery(meQuery);
}

/**
 * The signed-in user AS ALREADY KNOWN to the cache — this observer never fetches.
 *
 * `RequireAuth` owns the `/auth/me` request. Anything that merely needs to know whether a
 * session exists reads it through here instead, so mounting the observer on a public route
 * (the landing page, the login form) does not buy an extra 401 to answer a question nobody
 * asked.
 */
export function useMeCached() {
  return useQuery({ ...meQuery, enabled: false }).data;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api.post<{ user: PublicUser }>('/auth/login', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; name: string }) =>
      api.post<{ user: PublicUser }>('/auth/register', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSuccess: () => qc.clear(),
  });
}

// ── investigations ──────────────────────────────────────────────────
export function useInvestigations(params: { status?: string; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.limit) search.set('limit', String(params.limit));
  const qs = search.toString();

  return useQuery({
    queryKey: ['investigations', params],
    queryFn: () =>
      api.get<{ items: Investigation[]; nextCursor: string | null }>(
        `/investigations${qs ? `?${qs}` : ''}`,
      ),
    staleTime: 30_000,
  });
}

export function useInvestigation(id: string | undefined) {
  return useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api.get<Investigation>(`/investigations/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export interface CreateInvestigationInput {
  name: string;
  description?: string;
  incidentReference?: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  windowStart: string;
  windowEnd: string;
  reportedIncidentAt?: string;
}

export function useCreateInvestigation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInvestigationInput) =>
      api.post<Investigation>('/investigations', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['investigations'] }),
  });
}

/**
 * Close an investigation — 06_BACKEND §6.4.2.
 *
 * The API soft-deletes: the document is flagged, not destroyed, and the scenes, detections,
 * origin estimates, candidate rankings, comments and audit trail attached to it all remain.
 * That is the point. An audit log that refers to an investigation nobody can look up is not
 * an audit log, and evidence that vanishes because a case was tidied away is evidence that
 * was never really kept (13_REAL_DATA_POLICY §13.4).
 *
 * Only the investigation's lead may. The queries for the case itself are removed rather than
 * refetched, because the next fetch would 404 and render as an error the user just caused.
 */
export function useDeleteInvestigation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/investigations/${id}`),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['investigations'] });
      qc.removeQueries({ queryKey: ['investigation', id] });
      qc.removeQueries({ queryKey: ['scenes', id] });
      qc.removeQueries({ queryKey: ['detections', id] });
      qc.removeQueries({ queryKey: ['candidates', id] });
    },
  });
}

// ── catalogue (live provider search — nothing persisted) ────────────
export interface CatalogueItem {
  productId: string;
  provider: string;
  platform: string;
  sensor: string;
  mode: string | null;
  polarisations: string[];
  orbitDirection: string | null;
  acquiredAt: string;
  aoiOverlapPct: number | null;
  cloudCoverPct: number | null;
  sizeBytes: number | null;
  collection: string;
  licence: string;
  preprocessed: boolean;
  footprint: { type: 'Polygon'; coordinates: number[][][] } | null;
}

export interface ProviderStatus {
  provider: string;
  status:
    | 'OK'
    | 'NO_RESULTS'
    | 'CIRCUIT_OPEN'
    | 'QUOTA_EXHAUSTED'
    | 'NOT_CONFIGURED'
    | 'TIMEOUT'
    | 'ERROR';
  count: number;
  latencyMs: number | null;
  reason?: string;
  retryAt?: string;
}

export interface CatalogueSearchResponse {
  items: CatalogueItem[];
  providerStatus: ProviderStatus[];
}

export interface CatalogueSearchArgs {
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  from: string;
  to: string;
  platforms?: string;
  limit?: number;
}

function catalogueUrl(args: CatalogueSearchArgs): string {
  const p = new URLSearchParams({
    aoi: JSON.stringify(args.aoi),
    from: args.from,
    to: args.to,
    limit: String(args.limit ?? 100),
  });
  if (args.platforms) p.set('platforms', args.platforms);
  return `/catalogue/search?${p.toString()}`;
}

/**
 * Live catalogue search. `staleTime: Infinity` + no automatic refetch: this hits real
 * providers under a quota, so it re-runs only when the user asks (05_FRONTEND §5.6.2).
 */
export function useCatalogueSearch(args: CatalogueSearchArgs | null, enabled = true) {
  return useQuery({
    queryKey: ['catalogue', args],
    queryFn: () => api.get<CatalogueSearchResponse>(catalogueUrl(args!)),
    enabled: enabled && args !== null,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

export interface ProviderHealth {
  provider: string;
  configured: boolean;
  calls: number;
  failures: number;
  p95LatencyMs: number | null;
  circuit: {
    state: string;
    consecutiveFailures: number;
    retryAt: string | null;
    lastSuccessAt: string | null;
  };
  quotas: Array<{ quotaKey: string; used: number; limit: number | null; resetAt: string | null }>;
}

export function useProviderHealth() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<{ items: ProviderHealth[] }>('/catalogue/providers'),
    staleTime: 30_000,
  });
}

// ── jobs ────────────────────────────────────────────────────────────
export interface Job {
  _id: string;
  jobKey: string;
  kind: string;
  queue: string;
  status: string;
  progress?: { pct: number; stage: string; message?: string };
  failureReason?: string;
  createdAt: string;
}

export function useJobs(investigationId?: string) {
  return useQuery({
    queryKey: ['jobs', investigationId],
    queryFn: () =>
      api.get<{ items: Job[] }>(
        `/jobs${investigationId ? `?investigationId=${investigationId}` : ''}`,
      ),
    staleTime: 5_000,
  });
}

// ── scenes & detections (Phase 4/6) ─────────────────────────────────
export interface Scene {
  _id: string;
  productId: string;
  platform: string;
  acquiredAt: string;
  crs: string;
  gsdMeters: number;
  status: string;
  polarisations: string[];
  orbitDirection: string | null;
  storage?: { bucket?: string; cogKey?: string; sizeBytes?: number };
  processing?: { preprocessing?: string };
  provenance: {
    sourceType: string;
    provider: string;
    datasetId: string;
    externalId: string;
    licence: string;
    retrievedAt: string;
    accessUrl?: string;
  };
}

export interface DetectionConfidence {
  meanOilProbability: number | null;
  lookAlikeCompetition: number;
  windSuitability: number;
  overall: number;
  modelTerm?: number;
  separationTerm?: number;
  windTerm?: number;
  shapeTerm?: number;
}

export interface Detection {
  _id: string;
  sceneId: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  areaKm2: number;
  perimeterKm: number;
  morphology: {
    majorAxisKm: number;
    minorAxisKm: number;
    elongationRatio: number;
    orientationDeg: number;
    convexity: number;
  };
  model: { name: string; version: string; artefactSha256: string };
  confidence: DetectionConfidence;
  reviewStatus: 'UNREVIEWED' | 'CONFIRMED' | 'REJECTED' | 'EDITED';
  reviewHistory: Array<{
    userId: string;
    action: string;
    at: string;
    note?: string;
    rejectionCategory?: string;
  }>;
  provenance: { sourceType: string; provider: string; datasetId: string; externalId: string };
}

export function useScenes(investigationId: string | undefined) {
  return useQuery({
    queryKey: ['scenes', investigationId],
    queryFn: () => api.get<{ items: Scene[] }>(`/investigations/${investigationId}/scenes`),
    enabled: Boolean(investigationId),
    staleTime: 30_000,
  });
}

export function useDetections(investigationId: string | undefined) {
  return useQuery({
    queryKey: ['detections', investigationId],
    queryFn: () => api.get<{ items: Detection[] }>(`/investigations/${investigationId}/detections`),
    enabled: Boolean(investigationId),
    staleTime: 15_000,
  });
}

export function useDetection(id: string | undefined) {
  return useQuery({
    queryKey: ['detection', id],
    queryFn: () => api.get<Detection>(`/detections/${id}`),
    enabled: Boolean(id),
  });
}

export interface DetectionVersion {
  version: number;
  action: string;
  at: string;
  userId: string | null;
  note?: string;
  rejectionCategory?: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  isModelOutput: boolean;
}

/**
 * The rejection taxonomy, fetched rather than hard-coded — 07_AIML §7.2.12.
 *
 * A copy in the frontend would be a second source of truth for a list the API validates
 * against, and the failure mode is a category that is offered in the dropdown and refused
 * on submit. Cached for the session; the taxonomy changes with a deploy, not with a case.
 */
export interface RejectionCategory {
  id: string;
  label: string;
  kind: 'LOOK_ALIKE' | 'OPERATIONAL';
  /** Non-null iff this rejection is usable as a labelled negative for the detector. */
  sarClass: string | null;
  description: string;
}

export function useRejectionCategories() {
  return useQuery({
    queryKey: ['rejection-categories'],
    queryFn: () =>
      api.get<{ items: RejectionCategory[]; note: string }>('/detections/rejection-categories'),
    staleTime: Infinity,
  });
}

export function useDetectionVersions(id: string | undefined) {
  return useQuery({
    queryKey: ['detection-versions', id],
    queryFn: () =>
      api.get<{ items: DetectionVersion[]; note: string }>(`/detections/${id}/versions`),
    enabled: Boolean(id),
  });
}

export function useReviewDetection(investigationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      action: 'CONFIRM' | 'REJECT' | 'EDIT' | 'REOPEN';
      note?: string;
      rejectionCategory?: string;
      geometry?: { type: 'Polygon'; coordinates: number[][][] };
    }) =>
      api.post<{
        detectionId: string;
        reviewStatus: string;
        version: number;
        areaKm2: number;
        rejectionCategory?: string;
        // null when the rejection is recorded but contributes no labelled negative.
        trainingClass?: string | null;
      }>(`/detections/${v.id}/review`, {
        action: v.action,
        note: v.note,
        rejectionCategory: v.rejectionCategory,
        geometry: v.geometry,
      }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['detection', v.id] });
      void qc.invalidateQueries({ queryKey: ['detection-versions', v.id] });
      void qc.invalidateQueries({ queryKey: ['detections', investigationId] });
    },
  });
}

export function useIngestScene(investigationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) =>
      api.post<{ jobId: string; deduplicated: boolean }>(
        `/investigations/${investigationId}/scenes/ingest`,
        { productId },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['scenes', investigationId] });
    },
  });
}

// ── pipeline: origin estimation and correlation ─────────────────────────
//
// These two steps existed only as API routes: the workspace could ingest a scene and read
// results, but nothing in the UI could run back-tracking or correlation, so the chain from a
// detection to a ranked candidate could only be driven with curl.

export function useRunOrigin(investigationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { detectionId: string; horizonHours?: number; particleCount?: number }) =>
      api.post<{ jobId: string }>(`/investigations/${investigationId}/origin/run`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['origin', investigationId] });
    },
  });
}

export function useCorrelate(investigationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { detectionId: string; originEstimateId?: string }) =>
      api.post<{ jobId: string }>(`/investigations/${investigationId}/candidates/correlate`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['candidates', investigationId] });
    },
  });
}

// ── Discover: browse the sweep's watch regions, start investigating from there ──────
//
// A different entry point from every other hook above: those all read or act on ONE
// investigation a person already opened. These read across the sweep's own internal
// containers instead — see `apps/api/src/modules/discover/service.ts` for why that read
// deliberately crosses the ordinary investigation boundary — and `adopt` is the one place a
// scene changes which investigation owns it.

export interface DiscoverRegion {
  id: string;
  label: string;
  region: string;
  bbox: [number, number, number, number];
  aisCoverage: 'STAGED' | 'OBTAINABLE' | 'NONE';
  note: string;
  aoi: { type: 'Polygon'; coordinates: number[][][] };
  /** What the last sweep of this region actually saw — null before the first tick. */
  status: {
    lastSweptAt: string | null;
    overpassesSeen: number | null;
    ingestible: number | null;
    enqueued: number | null;
    error: string | null;
  };
}

export function useDiscoverRegions() {
  return useQuery({
    queryKey: ['discover-regions'],
    // The four watch regions are a fixed, deployed constant — see
    // packages/shared/src/watchRegions.ts — so there is nothing to invalidate this against.
    queryFn: () => api.get<{ items: DiscoverRegion[] }>('/discover/regions'),
    staleTime: Infinity,
  });
}

export interface DiscoverDetection {
  _id: string;
  regionId: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  areaKm2: number;
  confidence: { overall: number; lookAlikeCompetition: number } | Record<string, number>;
  morphology: Record<string, number>;
  reviewStatus: string;
  sceneId: string;
  productId: string;
  acquiredAt: string;
  /** The investigation that owns the scene this sits on. */
  investigationId: string;
  /** Already in an ordinary investigation, so it wants opening rather than adopting again. */
  adopted: boolean;
}

export interface DiscoverDetectionsResult {
  items: DiscoverDetection[];
  /**
   * Findings in these regions that fall outside the requested window. Surfaced so an empty
   * list can say WHY it is empty — "nothing here" and "nothing in this period" are different
   * answers and the period control is the most likely reason for the second.
   */
  outsidePeriod: { count: number; earliest: string | null; latest: string | null };
}

export function useDiscoverDetections(from: string, to: string, regionId?: string) {
  const search = new URLSearchParams({ from, to });
  if (regionId) search.set('regionId', regionId);
  return useQuery({
    queryKey: ['discover-detections', from, to, regionId],
    queryFn: () => api.get<DiscoverDetectionsResult>(`/discover/detections?${search}`),
    enabled: Boolean(from && to),
    staleTime: 60_000,
  });
}

/**
 * An acquisition the sweep saw — a satellite having looked, which is a different and much
 * more common fact than VARUNA having found something. `ingestible` is why it may not have
 * produced a detection, stated by the provider rather than guessed here.
 */
export interface DiscoverOverpass {
  _id: string;
  regionId: string;
  productId: string;
  provider: string;
  collection: string;
  acquiredAt: string;
  platform: string | null;
  footprint: { type: 'Polygon'; coordinates: number[][][] } | null;
  ingestible: boolean;
  ingestibleReason: string | null;
}

export function useDiscoverOverpasses(from: string, to: string, regionId?: string) {
  const search = new URLSearchParams({ from, to });
  if (regionId) search.set('regionId', regionId);
  return useQuery({
    queryKey: ['discover-overpasses', from, to, regionId],
    queryFn: () => api.get<{ items: DiscoverOverpass[] }>(`/discover/overpasses?${search}`),
    enabled: Boolean(from && to),
    staleTime: 60_000,
  });
}

/**
 * Run a sweep now. Returns the job id so the caller can follow it in `GET /jobs` — an
 * unscoped job is visible only to whoever created it, which is exactly the person who
 * pressed the button.
 */
export function useTriggerSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { regionId?: string }) =>
      api.post<{ jobId: string; deduplicated: boolean; regionId: string | null }>(
        '/discover/sweep',
        body,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

/**
 * The caller's own unscoped jobs, polled while any is still running.
 *
 * Sockets would be the obvious choice, but an unscoped sweep emits only into the `/jobs`
 * namespace and `SocketProvider` connects only to `/investigations` — so following one live
 * would mean opening a second namespace connection for a single button. This mirrors what
 * `JobActivity` already does for investigation-scoped jobs.
 */
export function useSweepJobs(enabled: boolean) {
  return useQuery({
    queryKey: ['jobs', 'sweep'],
    queryFn: () => api.get<{ items: Job[] }>('/jobs?limit=20'),
    enabled,
    select: (d) => d.items.filter((j) => j.kind === 'SWEEP_TICK'),
    // `q.state.data` is the RAW response, NOT the `select`-transformed value — so it is
    // `{ items }`, not an array. An earlier version cast it to `Job[]` and called `.some` on
    // it, which type-checked only because the cast said so and crashed the whole page on
    // first render.
    refetchInterval: (q) => {
      const running = q.state.data?.items.some(
        (j) => j.kind === 'SWEEP_TICK' && (j.status === 'QUEUED' || j.status === 'RUNNING'),
      );
      return running ? 2_000 : false;
    },
  });
}

export interface AdoptDetectionResult {
  investigationId: string;
  created: boolean;
  adoptedDetectionCount: number;
}

export function useAdoptDetection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, investigationId }: { id: string; investigationId?: string }) =>
      api.post<AdoptDetectionResult>(`/discover/detections/${id}/adopt`, { investigationId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['discover-detections'] });
      void qc.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}
