import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatUtc } from '../../lib/format.ts';
import { SceneReadout } from '../scenes/SceneReadout.tsx';
import {
  confidenceToken,
  fromLocalInput,
  inspectSceneFile,
  toLocalInput,
  uploadSceneFile,
  type InspectResponse,
  type UploadResponse,
} from '../scenes/sceneFile.ts';

/**
 * Browse for a SAR scene, and let the file describe itself — 06_BACKEND §6.4.4.
 *
 * The catalogue path covers scenes a public archive holds. This covers the case an analyst
 * actually arrives with: a GeoTIFF from a national agency, a partner, or an acquisition the
 * free catalogues do not carry.
 *
 * It used to be two fields, the second of which the analyst had to fill in from memory —
 * and that second field is the acquisition instant every AIS query is centred on, where a
 * mistake does not fail loudly but instead ranks real ships that were somewhere else. So the
 * file is now read the moment it is picked: the browser sends the header slice to
 * `/scenes/inspect`, and what comes back fills the form.
 *
 * Two rules keep that from being a lie dressed as convenience:
 *
 *  - **Only an unambiguous statement is adopted.** A mission product identifier, or a
 *    metadata key that means acquisition. A weak signal — TIFFTAG_DATETIME, a bare date —
 *    is listed with its source and what it actually means, for the analyst to accept or not.
 *  - **Everything shown says where it came from.** Each value names the tag or key it was
 *    read from, and the preview extent is labelled a preview: the authoritative geometry
 *    comes from the ingest.
 *
 * The same reading also starts an investigation from scratch — see `StartFromScene`. Both
 * share `features/scenes`, so a file reads identically whichever door it comes through.
 */
export function SceneUpload({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [acquiredAt, setAcquiredAt] = useState('');
  /**
   * The full-precision instant behind the input, when it came from the file.
   *
   * `datetime-local` resolves to the minute. A Sentinel-1 sensing start has seconds, and
   * throwing them away to satisfy a form control would quietly degrade a value the file
   * stated exactly. Kept here and sent instead of the input whenever the two still agree.
   */
  const [exactIso, setExactIso] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);

  function adopt(value: string) {
    setAcquiredAt(toLocalInput(value));
    setExactIso(value);
  }

  async function inspect(picked: File) {
    setInspecting(true);
    setInspection(null);
    setError(null);

    try {
      const parsed = await inspectSceneFile(picked, investigationId);
      setInspection(parsed);
      // Adopted only when the SERVER decided it was unambiguous. The frontend does not get
      // to promote a weak candidate; that judgement lives in one place.
      if (parsed.metadata.acquiredAt) adopt(parsed.metadata.acquiredAt);
    } catch (err) {
      // A failed read is not a failed upload. The file may still be perfectly good, so this
      // is reported as what it is and the manual field stays available.
      setInspection(null);
      setError(
        err instanceof Error
          ? `Could not read the file's details (${err.message}). You can still upload it and enter the acquisition time yourself.`
          : 'Could not read the file’s details.',
      );
    } finally {
      setInspecting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    setResult(null);

    // When the field is empty the server extracts it, and refuses with what it found if the
    // file does not state it unambiguously. Sending nothing is not the same as sending a guess.
    let send: string | undefined;
    if (acquiredAt) {
      const edited = exactIso === null || toLocalInput(exactIso) !== acquiredAt;
      send = edited ? fromLocalInput(acquiredAt) : exactIso!;
    }

    try {
      setResult(await uploadSceneFile(investigationId, file, send));
      setFile(null);
      setInspection(null);
      setAcquiredAt('');
      setExactIso(null);
      if (fileRef.current) fileRef.current.value = '';
      await qc.invalidateQueries({ queryKey: ['scenes', investigationId] });
      await qc.invalidateQueries({ queryKey: ['detections', investigationId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scene could not be accepted.');
    } finally {
      setBusy(false);
    }
  }

  const meta = inspection?.metadata;
  const suggestions = (meta?.acquisitionCandidates ?? []).filter((c) => c.value !== exactIso);

  return (
    <section className="card">
      <h2>Add a scene from a file</h2>
      <p className="muted">
        A preprocessed SAR GeoTIFF — linear Sigma0, georeferenced. Pick it and VARUNA reads its
        details out of the file itself; it is then detected, back-tracked to an origin and
        correlated against AIS exactly as a catalogue scene is.
      </p>

      <form className="upload-form" onSubmit={submit}>
        <label htmlFor="scene-file">SAR image (GeoTIFF)</label>
        <input
          id="scene-file"
          ref={fileRef}
          type="file"
          accept=".tif,.tiff,image/tiff"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            setFile(picked);
            setError(null);
            setResult(null);
            setAcquiredAt('');
            setExactIso(null);
            setInspection(null);
            if (picked) void inspect(picked);
          }}
        />
        {file ? (
          <p className="field-hint mono">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
        ) : null}

        {inspecting ? <p className="field-hint">Reading the file…</p> : null}
        {inspection ? <SceneReadout inspection={inspection} /> : null}

        <label htmlFor="acquired-at">Acquisition time (UTC)</label>
        <input
          id="acquired-at"
          type="datetime-local"
          value={acquiredAt}
          onChange={(e) => setAcquiredAt(e.target.value)}
        />

        {meta?.acquiredAt && exactIso === meta.acquiredAt ? (
          // Filled in, and it says by what. An adopted value the analyst cannot trace is
          // indistinguishable from one the form made up.
          <p className="field-hint scene-read-adopted">
            Filled in from the file — {meta.acquiredAtSource}. Change it if you know better.
          </p>
        ) : (
          <p className="field-hint">
            When the radar observed the scene — not when the file was made. AIS is searched in a
            window around it, so a wrong value ranks vessels that were nowhere near the spill.
          </p>
        )}

        {meta?.acquisitionConflict ? (
          <p className="scene-read-warn">{meta.acquisitionConflict}</p>
        ) : null}

        {suggestions.length > 0 ? (
          <div className="scene-read-candidates">
            <p className="field-hint">
              {meta?.acquiredAt
                ? 'Other times mentioned in the file:'
                : 'The file mentions these times, none of them unambiguously the acquisition:'}
            </p>
            <ul className="scene-read-candidates-list">
              {suggestions.map((c) => (
                <li key={`${c.value}-${c.source}`}>
                  <button type="button" className="btn btn-ghost" onClick={() => adopt(c.value)}>
                    Use {formatUtc(c.value)}
                  </button>
                  <span className={confidenceToken(c.confidence)}>{c.confidence}</span>
                  <span className="scene-read-source">{c.source}</span>
                  <span className="field-hint">{c.note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="form-error" role="alert">
          {error ?? ''}
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={!file || busy || inspecting || inspection?.acceptable === false}
        >
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
          <p className="field-hint">
            Acquisition time {formatUtc(result.acquiredAt)}
            {result.acquiredAtSource ? ` · ${result.acquiredAtSource}` : ''}
          </p>
          {/* Shown here, not only stored. Whoever uploads this should learn now that the
              resulting scene is labelled unverified everywhere it appears. */}
          <p className="upload-provenance">{result.provenanceNotice}</p>
        </div>
      ) : null}
    </section>
  );
}
