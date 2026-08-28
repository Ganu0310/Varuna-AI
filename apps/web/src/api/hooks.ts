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
