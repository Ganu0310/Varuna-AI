import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client.ts';

/**
 * Browse for a SAR scene and attribute it — 06_BACKEND §6.4.4.
 *
 * The catalogue path covers scenes a public archive holds. This covers the case an analyst
 * actually arrives with: a GeoTIFF from a national agency, a partner, or an acquisition the
 * free catalogues do not carry.
 *
 * Two fields, and the second one is the interesting one. **Acquisition time is required and
 * cannot be read from the file.** `TIFFTAG_DATETIME` records when the file was WRITTEN — for
 * a re-exported product, the day someone opened it in QGIS. Every AIS query is a window
 * around the observation instant, so a wrong value here does not fail loudly: it returns real
 * positions of real ships that were simply somewhere else, and ranks them confidently. The
 * form says that before you submit rather than after.
 *
 * Rejections are shown verbatim. The server explains why a file cannot be used — no
 * georeferencing, values that look like dB rather than linear backscatter — and that
 * explanation is the analyst's next action, so summarising it would throw away the useful part.
 */
export function SceneUpload({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [acquiredAt, setAcquiredAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    jobId: string;
    productId: string;
    checksum: string;
    deduplicated: boolean;
    provenanceNotice: string;
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !acquiredAt) return;

    setBusy(true);
    setError(null);
    setResult(null);

    const body = new FormData();
    body.append('scene', file);
    // The datetime-local input has no zone. The whole system works in UTC and every timestamp
    // it shows is labelled Z, so the value is read as UTC rather than as the browser's local
    // time — which would shift the AIS search window by hours for most of the world.
    body.append('acquiredAt', new Date(`${acquiredAt}:00Z`).toISOString());

    try {
      // Sent with `fetch` rather than the shared api client: that wrapper sets a JSON
      // content-type, and a multipart body must be allowed to set its own boundary.
      const res = await fetch(`/api/v1/investigations/${investigationId}/scenes/upload`, {
        method: 'POST',
        credentials: 'include',
        body,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new ApiError(
          res.status,
          json as never,
          String(json.detail ?? json.title ?? 'The scene could not be accepted.'),
        );
      }
      setResult(json as never);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await qc.invalidateQueries({ queryKey: ['scenes', investigationId] });
      await qc.invalidateQueries({ queryKey: ['detections', investigationId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scene could not be accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Browse for a scene</h2>
      <p className="muted">
        A preprocessed SAR GeoTIFF — linear Sigma0, georeferenced. It is detected, back-tracked to
        an origin and correlated against AIS exactly as a catalogue scene is.
      </p>

      <form className="upload-form" onSubmit={submit}>
        <label htmlFor="scene-file">SAR image (GeoTIFF)</label>
        <input
          id="scene-file"
          ref={fileRef}
          type="file"
          accept=".tif,.tiff,image/tiff"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
        />
        {file ? (
          <p className="field-hint mono">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
        ) : null}

        <label htmlFor="acquired-at">Acquisition time (UTC)</label>
        <input
          id="acquired-at"
          type="datetime-local"
          value={acquiredAt}
          onChange={(e) => setAcquiredAt(e.target.value)}
          required
        />
        <p className="field-hint">
          When the radar observed the scene — not when the file was made. This cannot be read from
          the GeoTIFF, and AIS is searched in a window around it, so a wrong value ranks vessels
          that were nowhere near the spill.
        </p>

        <div className="form-error" role="alert">
          {error ?? ''}
        </div>

        <button type="submit" className="btn btn-primary" disabled={!file || !acquiredAt || busy}>
          {busy ? 'Uploading…' : 'Upload and detect'}
        </button>
      </form>

      {result ? (
        <div className="upload-result">
          <p>
            <strong>Accepted.</strong>{' '}
            {result.deduplicated
              ? 'These exact bytes were already uploaded, so no duplicate work was queued.'
              : 'Detection is queued — watch Activity for progress.'}
          </p>
          <p className="field-hint mono">
            {result.productId} · job {result.jobId}
          </p>
          {/* Shown here, not only stored. Whoever uploads this should learn now that the
              resulting scene is labelled unverified everywhere it appears. */}
          <p className="upload-provenance">{result.provenanceNotice}</p>
        </div>
      ) : null}
    </section>
  );
}
