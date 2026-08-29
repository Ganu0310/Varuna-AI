import { useState } from 'react';
import { useDetections, useRunOrigin, useCorrelate } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Origin estimation and correlation — the two pipeline steps that had no UI.
 *
 * Both existed as API routes but nothing could call them, so an analyst could ingest a scene
 * and read finished results while the steps between were reachable only with curl. This is
 * where a detection becomes a release zone, and a release zone becomes a ranked list.
 *
 * The panel is deliberately explicit about ORDER. Correlation without an origin estimate is
 * refused by the server with a 409, and rather than let someone discover that by clicking,
 * the control is disabled with the reason stated next to it.
 */

interface OriginSummary {
  status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
  method: string;
  degradationReason: string | null;
  releaseWindow?: {
    earliest: string;
    latest: string;
    mostLikelyStart: string;
    mostLikelyEnd: string;
    status: 'OK' | 'WIDE';
  };
}

interface Props {
  investigationId: string;
  origin: OriginSummary | null;
  originReason: string | undefined;
}

export function OriginPanel({ investigationId, origin, originReason }: Props) {
  const detections = useDetections(investigationId);
  const runOrigin = useRunOrigin(investigationId);
  const correlate = useCorrelate(investigationId);
  const [detectionId, setDetectionId] = useState('');

  const items = detections.data?.items ?? [];
  // Correlation searches around a slick the analyst believes is real. Offering a REJECTED
  // detection would invite ranking vessels against something already ruled out.
  const usable = items.filter((d) => d.reviewStatus !== 'REJECTED');
  const chosen = detectionId || usable[0]?._id || '';

  const err = (e: unknown) =>
    e instanceof ApiError ? (e.problem?.detail ?? e.problem?.title ?? e.message) : String(e);

  return (
    <div className="stack-sm">
      <section className="card">
        <h2>Origin estimate</h2>

        {usable.length === 0 ? (
          <p className="muted">
            No detection to back-track yet. Ingest a scene and review its detections first —
            back-tracking starts from a slick outline, so there is nothing to run without one.
          </p>
        ) : (
          <>
            <label htmlFor="det">Detection to back-track</label>
            <select id="det" value={chosen} onChange={(e) => setDetectionId(e.target.value)}>
              {usable.map((d) => (
                <option key={d._id} value={d._id}>
                  {d.areaKm2.toFixed(2)} km² · confidence {(d.confidence?.overall ?? 0).toFixed(2)}{' '}
                  · {d.reviewStatus}
                </option>
              ))}
            </select>

            <div className="form-error" role="alert">
              {runOrigin.isError ? err(runOrigin.error) : ''}
            </div>

            <button
              onClick={() => runOrigin.mutate({ detectionId: chosen })}
              disabled={!chosen || runOrigin.isPending}
            >
              {runOrigin.isPending ? 'Queuing…' : 'Run back-tracking'}
            </button>
            <p className="field-hint">
              Runs a backward Lagrangian drift ensemble against real current and wind fields. If no
              forcing covers this date the run still completes, but DEGRADED — falling back to
              footprint proximity, which cannot tell upstream from downstream.
            </p>
          </>
        )}

        {origin ? (
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <span className={`token ${origin.status === 'OK' ? 'status-ok' : 'status-warn'}`}>
                {origin.status}
              </span>
            </dd>
            <dt>Method</dt>
            <dd className="mono">{origin.method}</dd>
            {origin.releaseWindow ? (
              <>
                <dt>Release window</dt>
                <dd className="mono">
                  {formatUtc(origin.releaseWindow.earliest)} →{' '}
                  {formatUtc(origin.releaseWindow.latest)}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {origin?.degradationReason ? (
          // Stated here as well as in the report: an analyst deciding whether to correlate
          // needs to know the zone is a proximity buffer BEFORE they read a ranking built
          // on it.
          <p className="field-hint">{origin.degradationReason}</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Correlate AIS</h2>

        {!origin ? (
          <p className="muted">
            {originReason === 'NOT_RUN'
              ? 'Back-tracking has not been run. Correlation needs a release zone and window ' +
                'to search against — matching vessels to the detection footprint alone cannot ' +
                'separate a discharging vessel from ordinary passing traffic.'
              : 'No origin estimate is available.'}
          </p>
        ) : (
          <>
            <div className="form-error" role="alert">
              {correlate.isError ? err(correlate.error) : ''}
            </div>
            <button
              onClick={() => correlate.mutate({ detectionId: chosen })}
              disabled={!chosen || correlate.isPending}
            >
              {correlate.isPending ? 'Queuing…' : 'Rank candidate vessels'}
            </button>
            <p className="field-hint">
              Scores every vessel with AIS in the release envelope across twelve evidence features,
              renormalised over the ones that could actually be measured.
              {origin.status === 'DEGRADED'
                ? ' Because the origin is degraded, every candidate will be capped at MODERATE.'
                : ''}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
