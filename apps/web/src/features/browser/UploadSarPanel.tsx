import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api/client.ts';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

type Phase =
  | 'idle'
  | 'invalid'
  | 'ready'
  | 'uploading'
  | 'processing'
  | 'processed'
  | 'detecting'
  | 'detected'
  | 'error';

interface DetectRow {
  _id: string;
  areaKm2: number;
  confidence?: { overall?: number; lookAlikeCompetition?: number };
}

function humanSize(n: number): string {
  const mb = n / 1_048_576;
  return mb >= 1024
    ? `${(mb / 1024).toFixed(2)} GB`
    : mb >= 1
      ? `${mb.toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`;
}

/** Detect format from name + first bytes; only geocoded GeoTIFF is a valid SAR input. */
async function classify(file: File): Promise<{ format: string; ok: boolean; reason?: string }> {
  const name = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isTiff =
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a);
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isZip = head[0] === 0x50 && head[1] === 0x4b;

  if (isJpeg || isPng || /\.(jpe?g|png)$/.test(name))
    return {
      format: isPng ? 'PNG' : 'JPEG',
      ok: false,
      reason:
        'This is an optical image, not radar. Sentinel-1 is SAR — an optical picture cannot ' +
        'be run through SAR oil-spill detection.',
    };
  if (isZip || /\.(zip|safe)$/.test(name))
    return {
      format: name.endsWith('.safe') ? 'Sentinel-1 SAFE' : 'ZIP',
      ok: false,
      reason:
        'A raw Sentinel-1 SAFE/SLC/GRD product is in radar geometry with no map projection. ' +
        'This build does not run terrain correction. Upload a geocoded GeoTIFF (e.g. an RTC ' +
        'export), or use the archive search — it pulls already-corrected RTC scenes.',
    };
  if (isTiff || /\.(tiff?)$/.test(name)) return { format: 'GeoTIFF', ok: true };
  return { format: 'unknown', ok: false, reason: 'Expected a GeoTIFF (.tif/.tiff).' };
}

export function UploadSarPanel({
  aoi,
}: {
  aoi: { type: 'Polygon'; coordinates: number[][][] } | null;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);

  const [investigationId, setInvestigationId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [detections, setDetections] = useState<DetectRow[]>([]);

  const pick = useCallback(async (f: File | undefined) => {
    if (!f) return;
    setError('');
    setDetections([]);
    setInvestigationId(null);
    setSceneId(null);
    setPct(0);
    setFile(f);
    const c = await classify(f);
    setFormat(c.format);
    if (!c.ok) {
      setPhase('invalid');
      setError(c.reason ?? 'Unsupported file.');
    } else {
      setPhase('ready');
    }
  }, []);

  const pollJob = async (invId: string, matchKind: 'INGEST' | 'DETECTION') => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const { items } = await api.get<{
        items: Array<{
          kind: string;
          status: string;
          failureReason?: string;
          progress?: { stage?: string; message?: string };
        }>;
      }>(`/jobs?investigationId=${invId}`);
      const job = items.find((j) => j.kind === matchKind);
      if (!job) continue;
      if (job.progress?.message) setMsg(job.progress.message);
      if (job.status === 'COMPLETED') return;
      if (job.status === 'FAILED') throw new Error(job.failureReason || `${matchKind} job failed`);
    }
    throw new Error(`${matchKind} timed out`);
  };

  const process = async () => {
    if (!file) return;
    try {
      // 1 · upload the raw bytes (XHR for progress; fetch cannot report upload progress)
      setPhase('uploading');
      setMsg('Uploading raster…');
      const upload = await new Promise<{ uploadKey: string; filename: string; sizeBytes: number }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(
            'POST',
            `${API_BASE}/api/v1/uploads/raster?filename=${encodeURIComponent(file.name)}`,
          );
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
            else {
              let d = xhr.responseText;
              try {
                d = JSON.parse(xhr.responseText).detail ?? d;
              } catch {
                /* keep raw */
              }
              reject(new Error(d || `Upload failed (HTTP ${xhr.status})`));
            }
          };
          xhr.onerror = () => reject(new Error('Upload failed (network error)'));
          xhr.send(file);
        },
      );

      // 2 · an investigation to attach the scene to
      setPhase('processing');
      setPct(100);
      setMsg('Registering the scene…');
      const m = file.name.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const acq = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : new Date();
      const day = 86_400_000;
      const box = aoi ?? {
        type: 'Polygon' as const,
        coordinates: [
          [
            [-0.2, -0.2],
            [0.2, -0.2],
            [0.2, 0.2],
            [-0.2, 0.2],
            [-0.2, -0.2],
          ],
        ],
      };
      const inv = await api.post<{ _id: string }>('/investigations', {
        name: `Upload · ${file.name.replace(/\.(tiff?)$/i, '')}`.slice(0, 180),
        aoi: box,
        windowStart: new Date(acq.getTime() - day).toISOString(),
        windowEnd: new Date(acq.getTime() + day).toISOString(),
        reportedIncidentAt: acq.toISOString(),
      });
      setInvestigationId(inv._id);

      // 3 · run it through the SAME ingest → SAR-preprocess pipeline (no detect yet)
      setMsg('Converting to a Cloud-Optimised GeoTIFF…');
      await api.post(`/investigations/${inv._id}/scenes/ingest`, {
        uploadKey: upload.uploadKey,
        filename: upload.filename,
      });
      await pollJob(inv._id, 'INGEST');

      const scenes = await api.get<{ items: Array<{ _id: string }> }>(
        `/investigations/${inv._id}/scenes`,
      );
      const sid = scenes.items[0]?._id ?? null;
      setSceneId(sid);
      setPhase('processed');
      setMsg('');
    } catch (e) {
      setPhase('error');
      setError(e instanceof ApiError ? (e.problem?.detail ?? e.message) : (e as Error).message);
    }
  };

  const runDetection = async () => {
    if (!investigationId || !sceneId) return;
    try {
      setPhase('detecting');
      setMsg('Running the classical dark-spot detector…');
      await api.post(`/investigations/${investigationId}/scenes/${sceneId}/detect`, {});
      await pollJob(investigationId, 'DETECTION');
      const res = await api.get<{ items: DetectRow[] }>(
        `/investigations/${investigationId}/detections`,
      );
      setDetections(res.items);
      setPhase('detected');
      setMsg('');
    } catch (e) {
      setPhase('error');
      setError(e instanceof ApiError ? (e.problem?.detail ?? e.message) : (e as Error).message);
    }
  };

  const busy = phase === 'uploading' || phase === 'processing' || phase === 'detecting';
  const topConf = detections.length
    ? Math.max(...detections.map((d) => d.confidence?.overall ?? 0))
    : 0;

  return (
    <section className="card upload-panel">
      <div className="card-head">
        <h2>Upload Sentinel-1 image</h2>
        <span className="token">SAR GeoTIFF</span>
      </div>
      <p className="muted">
        Process your own <strong>geocoded</strong> Sentinel-1 GeoTIFF (e.g. an RTC export) through
        the same ingest → SAR-preprocess → detection pipeline as an archive scene. Raw SAFE/SLC/GRD
        and optical images (JPEG/PNG) are not SAR-detectable and are rejected here.
      </p>

      <div
        className={`dropzone${drag ? ' is-drag' : ''}${phase === 'invalid' ? ' is-invalid' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void pick(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".tif,.tiff,image/tiff"
          hidden
          onChange={(e) => void pick(e.target.files?.[0] ?? undefined)}
        />
        {file ? (
          <div className="dz-file">
            <strong className="mono">{file.name}</strong>
            <span className="muted">
              {humanSize(file.size)} · detected format: <span className="mono">{format}</span>
            </span>
          </div>
        ) : (
          <div className="dz-empty">
            <span className="dz-icon" aria-hidden="true">
              ⭱
            </span>
            <span>Drop a GeoTIFF here, or click to choose a file</span>
          </div>
        )}
      </div>

      {phase === 'invalid' || (phase === 'error' && error) ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {(phase === 'uploading' || phase === 'processing') && (
        <div className="upload-progress">
          <div className="bar">
            <span style={{ width: `${phase === 'uploading' ? pct : 100}%` }} />
          </div>
          <span className="mono">
            {phase === 'uploading' ? `Uploading ${pct}%` : 'Processing…'} {msg}
          </span>
        </div>
      )}
      {phase === 'detecting' && <p className="field-hint mono">Detecting… {msg}</p>}

      <div className="scene-actions">
        {(phase === 'ready' || phase === 'error') && (
          <button
            className="btn-primary"
            onClick={process}
            disabled={!file || (phase === 'error' && !file)}
          >
            Process image
          </button>
        )}
        {busy && (
          <button className="btn-primary" disabled>
            Working…
          </button>
        )}
        {(phase === 'processed' || phase === 'detected') && (
          <>
            <button className="btn-primary" onClick={runDetection}>
              Run oil spill detection
            </button>
            <a className="btn-ghost" href={`/investigations/${investigationId}`}>
              Open in workspace
            </a>
          </>
        )}
        {(phase === 'processed' || phase === 'detected' || phase === 'detecting') && file && (
          <button
            className="btn-ghost"
            onClick={() => {
              setFile(null);
              setPhase('idle');
              setDetections([]);
              setInvestigationId(null);
              setSceneId(null);
              setError('');
            }}
          >
            Upload another
          </button>
        )}
      </div>

      {(phase === 'processed' || phase === 'detected' || phase === 'detecting') &&
        investigationId &&
        sceneId && (
          <div className="upload-result">
            <figure className="sar-preview">
              <img
                src={`${API_BASE}/api/v1/investigations/${investigationId}/scenes/${sceneId}/preview.png`}
                alt="SAR backscatter preview of the uploaded scene"
                loading="lazy"
              />
              <figcaption className="muted">
                Sigma0 backscatter, stretched for display only. Dark = low return (calm water, or
                oil damping capillary waves).
              </figcaption>
            </figure>

            {phase === 'detected' && (
              <div className="detect-summary">
                {detections.length === 0 ? (
                  <p>
                    The detector found no dark features meeting the oil-like shape/contrast
                    thresholds in this scene.
                  </p>
                ) : (
                  <>
                    <p>
                      <strong>{detections.length}</strong>{' '}
                      {detections.length === 1 ? 'candidate slick' : 'candidate slicks'} · top
                      detector confidence <strong>{(topConf * 100).toFixed(0)}%</strong>.
                    </p>
                    <table className="rows">
                      <tbody>
                        {detections.slice(0, 6).map((d) => (
                          <tr key={d._id}>
                            <td className="mono">{d.areaKm2.toFixed(3)} km²</td>
                            <td className="rows-meta mono">
                              conf {(d.confidence?.overall ?? 0).toFixed(2)}
                            </td>
                            <td className="rows-meta mono">
                              look-alike {(d.confidence?.lookAlikeCompetition ?? 0).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="disclaimer-sm">
                      Classical detector: it locates dark features and scores how oil-like each is,
                      but cannot separate oil from look-alikes by texture. Open the workspace for
                      the georeferenced overlay and to investigate.
                    </p>
                    <button
                      className="btn-primary"
                      onClick={() => navigate(`/investigations/${investigationId}`)}
                    >
                      Investigate →
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
    </section>
  );
}
