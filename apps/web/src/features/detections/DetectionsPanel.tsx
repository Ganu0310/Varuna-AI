import { useState } from 'react';
import { useDetections, useScenes, useIngestScene, type Detection } from '../../api/hooks.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';
import { DetectionReview } from './DetectionReview.tsx';
import { DetectionVersions } from './DetectionVersions.tsx';
import { SceneUpload } from './SceneUpload.tsx';

/**
 * Detections panel — 05_FRONTEND §5.5.5.
 *
 * An UNREVIEWED detection is visually distinct (hatched), because a machine-produced
 * candidate and a human-confirmed one must never look the same in a screenshot that might
 * end up in a report.
 */
export function DetectionsPanel({ investigationId }: { investigationId: string }) {
  const scenes = useScenes(investigationId);
  const detections = useDetections(investigationId);
  const ingest = useIngestScene(investigationId);
  const [productId, setProductId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const items = detections.data?.items ?? [];

  return (
    <div className="stack">
      <section className="card">
        <h2>Scenes</h2>
        {scenes.isLoading ? (
          <p className="muted">Loading…</p>
        ) : (scenes.data?.items.length ?? 0) === 0 ? (
          <p className="muted">
            No scenes ingested yet. Search the catalogue for an acquisition covering this area, then
            ingest it by product ID.
          </p>
        ) : (
          /*
           * Stacked records, not a table. Six columns plus an untruncated product ID do not
           * fit a 480px side panel: the ID has no break opportunities, so in a ~54px column
           * the browser wrapped it one character per line and made a single row 457px tall.
           *
           * Truncating it is not the fix — 13_REAL_DATA_POLICY §13.9 requires the product ID
           * be shown in full, because it is the string an evaluator uses to pull the same
           * acquisition themselves. So the layout gives it a full-width line of its own.
           */
          <ul className="record-list">
            {scenes.data!.items.map((s) => (
              <li key={s._id} className="record">
                <div className="record-head">
                  <span className="mono record-title">{formatUtc(s.acquiredAt)}</span>
                  <span className="token">{s.processing?.preprocessing ?? '—'}</span>
                </div>
                <dl className="record-grid">
                  <dt>Platform</dt>
                  <dd>{s.platform}</dd>
                  <dt>Pol.</dt>
                  <dd className="mono">{s.polarisations.join('+')}</dd>
                  <dt>CRS</dt>
                  <dd className="mono">{s.crs}</dd>
                  <dt>Provider</dt>
                  <dd>{s.provenance.provider}</dd>
                </dl>
                {/* Full width, wrapping on its own line, never elided. */}
                <p className="record-id mono" title={s.provenance.externalId}>
                  {s.provenance.externalId}
                </p>
              </li>
            ))}
          </ul>
        )}

        <label htmlFor="pid">Ingest a scene by product ID</label>
        <input
          id="pid"
          className="mono"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          placeholder="S1C_IW_GRDH_1SDV_..._rtc"
        />
        <div className="form-error" role="alert">
          {ingest.isError ? (ingest.error as Error).message : ''}
        </div>
        <button onClick={() => ingest.mutate(productId)} disabled={!productId || ingest.isPending}>
          {ingest.isPending ? 'Queuing…' : 'Ingest and detect'}
        </button>
        {ingest.isSuccess ? (
          <p className="field-hint mono">
            job {ingest.data.jobId}
            {ingest.data.deduplicated ? ' (already ingested — no duplicate work)' : ''}
          </p>
        ) : null}
      </section>

      {/* Sits between the catalogue ingest and the results: an analyst arrives either with a
          product ID or with a file, and the two ways in belong next to each other. */}
      <SceneUpload investigationId={investigationId} />

      <section className="card">
        <h2>Detections</h2>
        {items.length === 0 ? (
          <p className="muted">
            No detections yet. Ingesting a scene runs the detector automatically.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th className="num">Area</th>
                <th className="num">Confidence</th>
                <th className="num">Look-alike risk</th>
                <th className="num">Elongation</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d: Detection) => (
                <tr key={d._id} className={d.reviewStatus === 'UNREVIEWED' ? 'row-unreviewed' : ''}>
                  <td className="num mono">{formatAreaKm2(d.areaKm2)}</td>
                  <td className="num mono">{d.confidence.overall.toFixed(2)}</td>
                  <td className="num mono">{d.confidence.lookAlikeCompetition.toFixed(2)}</td>
                  <td className="num mono">{d.morphology.elongationRatio.toFixed(2)}</td>
                  <td>
                    <span className={`token status-${d.reviewStatus.toLowerCase()}`}>
                      {d.reviewStatus}
                    </span>
                  </td>
                  <td>
                    <button className="btn-ghost" onClick={() => setSelected(d._id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected ? (
        <>
          <DetectionReview
            detectionId={selected}
            investigationId={investigationId}
            onClose={() => setSelected(null)}
          />
          <section className="card">
            <DetectionVersions detectionId={selected} />
          </section>
        </>
      ) : null}
    </div>
  );
}
