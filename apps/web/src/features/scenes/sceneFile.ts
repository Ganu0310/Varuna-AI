import { ApiError } from '../../api/client.ts';

/**
 * Reading a scene file in the browser — the shared half of two features.
 *
 * A GeoTIFF is picked in two places now: added to an investigation that exists, and used to
 * START one. Both do the same thing with the bytes — send the header, show what the file
 * says, and never adopt a value the file did not state unambiguously — so the transport, the
 * shapes and the rules live here rather than being written twice and drifting apart.
 */

/**
 * Enough for the first image file directory plus GDAL's metadata block in every COG seen.
 *
 * The whole file is not sent. A GeoTIFF states everything about itself in its first
 * directory, and pushing four gigabytes across the network to read a few hundred bytes of it
 * would make the preview cost more than the thing it previews.
 */
export const HEADER_SLICE_BYTES = 4 * 1024 * 1024;

export interface AcquisitionCandidate {
  value: string;
  source: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  note: string;
}

export interface ExtractedMetadata {
  readable: boolean;
  truncated: boolean;
  bigTiff: boolean;
  width: number | null;
  height: number | null;
  bandCount: number | null;
  sampleType: string | null;
  tiled: boolean;
  crs: string | null;
  crsSource: string | null;
  pixelSize: { x: number; y: number } | null;
  gsdMeters: number | null;
  footprint: { type: 'Polygon'; coordinates: number[][][] } | null;
  centre: { lon: number; lat: number } | null;
  footprintNote: string | null;
  acquisitionCandidates: AcquisitionCandidate[];
  acquiredAt: string | null;
  acquiredAtSource: string | null;
  acquisitionConflict: string | null;
  platform: string | null;
  mode: string | null;
  polarisations: string[];
  software: string | null;
}

export interface InspectResponse {
  acceptable: boolean;
  rejectionReason: string | null;
  originalName: string;
  bytesInspected: number;
  totalBytes: number | null;
  partial: boolean;
  metadata: ExtractedMetadata;
  /** Null when there is no investigation to compare the extent against. */
  aoi: { intersects: boolean; aoiCoveredPct: number | null; note: string } | null;
  window: { start: string; end: string } | null;
  note: string;
}

async function postFile<T>(path: string, body: FormData, fallback: string): Promise<T> {
  // Sent with `fetch` rather than the shared api client: that wrapper sets a JSON
  // content-type, and a multipart body must be allowed to set its own boundary.
  const res = await fetch(path, { method: 'POST', credentials: 'include', body });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, json as never, String(json.detail ?? json.title ?? fallback));
  }
  return json as T;
}

/**
 * Ask the API what this file says about itself.
 *
 * `investigationId` is optional: with one, the answer also says how the scene's extent sits
 * against that case's AOI; without one — the new-investigation form — there is no AOI to
 * compare with yet, and the response says so rather than inventing a comparison.
 */
export function inspectSceneFile(file: File, investigationId?: string): Promise<InspectResponse> {
  const body = new FormData();
  body.append('scene', file.slice(0, HEADER_SLICE_BYTES), file.name);
  // The name travels separately because the body is a slice: mission product identifiers
  // carry the sensing time, and that is the strongest evidence some files have.
  body.append('originalName', file.name);
  body.append('totalBytes', String(file.size));

  return postFile<InspectResponse>(
    investigationId
      ? `/api/v1/investigations/${investigationId}/scenes/inspect`
      : `/api/v1/scenes/inspect`,
    body,
    'The file could not be read.',
  );
}

export interface UploadResponse {
  jobId: string;
  productId: string;
  checksum: string;
  deduplicated: boolean;
  acquiredAt: string;
  acquiredAtSource: string | null;
  provenanceNotice: string;
}

/**
 * Send the whole file to an investigation, where it is stored, ingested and detected.
 *
 * `acquiredAt` is omitted when the caller has none to state — the server then extracts it,
 * and refuses with what it found if the file does not say unambiguously. Sending nothing is
 * not the same as sending a guess.
 */
export function uploadSceneFile(
  investigationId: string,
  file: File,
  acquiredAt?: string,
): Promise<UploadResponse> {
  const body = new FormData();
  body.append('scene', file);
  if (acquiredAt) body.append('acquiredAt', acquiredAt);

  return postFile<UploadResponse>(
    `/api/v1/investigations/${investigationId}/scenes/upload`,
    body,
    'The scene could not be accepted.',
  );
}

/** An ISO instant as the `datetime-local` input wants it — minutes, no zone, read as UTC. */
export function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

/** The reverse, for a value the analyst typed. The whole system works in UTC. */
export function fromLocalInput(local: string): string {
  return new Date(`${local}:00Z`).toISOString();
}

export function confidenceToken(c: AcquisitionCandidate['confidence']): string {
  return c === 'HIGH' ? 'token token-ok' : c === 'MEDIUM' ? 'token token-warn' : 'token';
}
