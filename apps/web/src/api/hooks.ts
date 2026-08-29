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
}

// ── auth ────────────────────────────────────────────────────────────
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: PublicUser; permissions: { role: Role } }>('/auth/me'),
    retry: false,
    staleTime: 30_000,
  });
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
  reviewHistory: Array<{ userId: string; action: string; at: string; note?: string }>;
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
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  isModelOutput: boolean;
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
      geometry?: { type: 'Polygon'; coordinates: number[][][] };
    }) =>
      api.post<{ detectionId: string; reviewStatus: string; version: number; areaKm2: number }>(
        `/detections/${v.id}/review`,
        { action: v.action, note: v.note, geometry: v.geometry },
      ),
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
