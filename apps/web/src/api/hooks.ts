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
