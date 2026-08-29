import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../../api/client.ts';
import { EvidenceWaterfall, type FeatureContribution } from '../candidates/EvidenceWaterfall.tsx';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

/**
 * `/investigations/:id/report` — the print-ready dossier (05_FRONTEND §5.5.10).
 *
 * This is the exact DOM that becomes the PDF. It renders in LIGHT theme at A4 width and
 * reuses the same `<EvidenceWaterfall>` the workspace shows, so the printed evidence and the
 * on-screen evidence cannot diverge.
 *
 * `Uncertainty & Limitations` and `Data Provenance` are rendered unconditionally and have no
 * toggle. They are not sections a user may drop: a dossier that names a vessel while omitting
 * what the analysis could not establish is not shorter, it is misleading.
 */
interface ReportData {
  investigation: {
    _id: string;
    name: string;
    incidentReference?: string;
    windowStart: string;
    windowEnd: string;
    aoiAreaKm2: number;
    status: string;
  };
  scenes: Array<{
    productId: string;
    platform: string;
    acquiredAt: string;
    crs: string;
    gsdMeters: number;
    polarisations: string[];
    provenance: { provider: string; datasetId: string; externalId: string; licence: string };
  }>;
  detections: Array<{
    _id: string;
    areaKm2: number;
    perimeterKm: number;
    morphology: Record<string, number>;
    confidence: Record<string, number>;
    reviewStatus: string;
    model: { name: string; version: string; artefactSha256: string };
  }>;
  origin: {
    method: string;
    status: string;
    degradationReason: string | null;
    releaseWindow?: Record<string, string>;
  } | null;
  aisCoverage: {
    source: string;
    recordCount: number;
    distinctVessels: number;
    medianIntervalSec: number | null;
    assessment: string;
  } | null;
  candidates: Array<{
    _id: string;
    rank: number;
    mmsi: number;
    score: number;
    scoreCI: [number, number];
    tier: string;
    measuredFeatureCount: number;
    calibrated: boolean;
    weightProfileId: string;
    features: FeatureContribution[];
  }>;
  uncertainty: {
    statements: Array<{ topic: string; text: string; severity: string }>;
    overall: string;
  };
  provenanceAppendix: {
    records: Array<{
      id: string;
      sourceType: string;
      provider: string;
      datasetId: string;
      externalId: string;
      licence: string;
      retrievedAt: string;
      derivedFrom: string[];
    }>;
    lineageNote: string;
  };
  manifest: Record<string, unknown>;
  generatedAt: string;
}

export function ReportPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.get<ReportData>(`/investigations/${id}/report/data`),
    enabled: Boolean(id),
  });

  if (isLoading)
    return (
      <main className="report">
        <p>Preparing dossier…</p>
      </main>
    );
  if (isError || !data)
    return (
      <main className="report">
        <p>Could not build the report.</p>
      </main>
    );

  const inv = data.investigation;

  return (
    // data-report-ready is what a headless renderer waits on before capturing the PDF.
    <main className="report" data-report-ready="true">
      {/*
        Hidden when printing (`.rp-toolbar` is display:none in the print stylesheet) so the
        dossier itself is only the dossier. The exports were reachable only by URL until now.
      */}
      <div className="rp-toolbar">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <span className="rp-toolbar-sep" aria-hidden="true" />
        {(
          [
            ['geojson', 'GeoJSON', 'geojson'],
            ['csv', 'CSV', 'csv'],
            ['manifest', 'Run manifest', 'json'],
          ] as const
        ).map(([kind, label, ext]) => (
          <button
            key={kind}
            className="btn-ghost"
            disabled={busy !== null}
            onClick={() => {
              setBusy(kind);
              setExportError(null);
              downloadFile(`/api/v1/investigations/${id}/exports/${kind}`, `varuna-${id}.${ext}`)
                .catch((e) =>
                  setExportError(
                    e instanceof ApiError
                      ? (e.problem?.detail ?? e.problem?.title ?? e.message)
                      : 'Download failed.',
                  ),
                )
                .finally(() => setBusy(null));
            }}
          >
            {busy === kind ? 'Preparing…' : label}
          </button>
        ))}
      </div>
      {exportError ? (
        <p className="form-error" role="alert">
          {exportError}
        </p>
      ) : null}

      <header className="rp-cover">
        <p className="rp-kicker">VARUNA · Vessel attribution dossier</p>
        <h1>{inv.name}</h1>
        {inv.incidentReference ? <p className="rp-ref mono">{inv.incidentReference}</p> : null}
        <dl className="rp-meta">
          <dt>Area of interest</dt>
          <dd>{formatAreaKm2(inv.aoiAreaKm2)}</dd>
          <dt>Window (UTC)</dt>
          <dd className="mono">
            {formatUtc(inv.windowStart)} → {formatUtc(inv.windowEnd)}
          </dd>
          <dt>Generated</dt>
          <dd className="mono">{formatUtc(data.generatedAt)}</dd>
        </dl>
        <p className="rp-disclaimer">
          This dossier ranks investigative leads. It is <strong>not</strong> a determination of
          responsibility. Read the Uncertainty &amp; Limitations section before acting on any
          finding in it.
        </p>
      </header>

      <section className="rp-section">
        <h2>1 · Satellite scenes</h2>
        {data.scenes.length === 0 ? (
          <p>No scenes were ingested for this investigation.</p>
        ) : (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Product ID</th>
                <th>Acquired (UTC)</th>
                <th>Platform</th>
                <th>CRS / GSD</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.scenes.map((s) => (
                <tr key={s.productId}>
                  {/* Full, untruncated: this is what an evaluator uses to find the same scene. */}
                  <td className="mono rp-id">{s.productId}</td>
                  <td className="mono">{formatUtc(s.acquiredAt)}</td>
                  <td>
                    {s.platform} {s.polarisations.join('+')}
                  </td>
                  <td className="mono">
                    {s.crs} / {s.gsdMeters} m
                  </td>
                  <td>{s.provenance.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rp-section">
        <h2>2 · Detections</h2>
        {data.detections.length === 0 ? (
          <p>No detections were produced.</p>
        ) : (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Area</th>
                <th>Elongation</th>
                <th>Confidence</th>
                <th>Look-alike risk</th>
                <th>Review</th>
                <th>Detector</th>
              </tr>
            </thead>
            <tbody>
              {data.detections.map((d) => (
                <tr key={d._id}>
                  <td className="mono">{formatAreaKm2(d.areaKm2)}</td>
                  <td className="mono">{d.morphology?.elongationRatio?.toFixed(2)}</td>
                  <td className="mono">{d.confidence?.overall?.toFixed(2)}</td>
                  {/* Beside confidence, never hidden behind it. */}
                  <td className="mono">{d.confidence?.lookAlikeCompetition?.toFixed(2)}</td>
                  <td>{d.reviewStatus}</td>
                  <td className="mono rp-id">
                    {d.model?.name}@{d.model?.version} · {d.model?.artefactSha256?.slice(0, 12)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rp-section">
        <h2>3 · Origin estimate</h2>
        {data.origin ? (
          <>
            <dl className="rp-meta">
              <dt>Method</dt>
              <dd className="mono">{data.origin.method}</dd>
              <dt>Status</dt>
              <dd className="mono">{data.origin.status}</dd>
            </dl>
            {data.origin.degradationReason ? (
              <p className="rp-caveat">{data.origin.degradationReason}</p>
            ) : null}
          </>
        ) : (
          <p className="rp-caveat">
            No origin estimate was produced, so no release location or time is stated in this
            dossier.
          </p>
        )}
      </section>

      <section className="rp-section">
        <h2>4 · AIS evidence base</h2>
        {data.aisCoverage ? (
          <>
            <p>{data.aisCoverage.assessment}</p>
            <dl className="rp-meta">
              <dt>Source</dt>
              <dd>{data.aisCoverage.source}</dd>
              <dt>Positions</dt>
              <dd className="mono">{data.aisCoverage.recordCount.toLocaleString()}</dd>
              <dt>Vessels</dt>
              <dd className="mono">{data.aisCoverage.distinctVessels}</dd>
              <dt>Median interval</dt>
              <dd className="mono">{data.aisCoverage.medianIntervalSec ?? '—'} s</dd>
            </dl>
          </>
        ) : (
          <p className="rp-caveat">No AIS coverage was available for this area and window.</p>
        )}
      </section>

      <section className="rp-section">
        <h2>5 · Candidate vessels</h2>
        <table className="rp-table">
          <thead>
            <tr>
              <th>#</th>
              <th>MMSI</th>
              <th>Score</th>
              <th>Assessment</th>
              <th>Features</th>
            </tr>
          </thead>
          <tbody>
            {data.candidates.map((c) => (
              <tr key={c._id}>
                <td className="mono">{c.rank}</td>
                <td className="mono">{c.mmsi}</td>
                <td className="mono">
                  {c.score.toFixed(1)} [{c.scoreCI[0].toFixed(0)}–{c.scoreCI[1].toFixed(0)}]
                </td>
                <td>{c.tier.replace(/_/g, ' ')}</td>
                <td className="mono">{c.measuredFeatureCount}/12</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.candidates.slice(0, 5).map((c) => (
        <section className="rp-section rp-break" key={`ev-${c._id}`}>
          <h2>
            Evidence · MMSI <span className="mono">{c.mmsi}</span> (rank {c.rank})
          </h2>
          {/* The same component the workspace renders, so printed and on-screen evidence
              cannot diverge. */}
          <EvidenceWaterfall
            features={c.features}
            measuredCount={c.measuredFeatureCount}
            score={c.score}
            scoreCI={c.scoreCI}
          />
        </section>
      ))}

      {/* MANDATORY — no toggle exists for this section. */}
      <section className="rp-section rp-break rp-mandatory">
        <h2>Uncertainty &amp; Limitations</h2>
        <p className="rp-locked">
          This section is always included and cannot be removed from a VARUNA dossier.
        </p>
        {data.uncertainty.statements.map((s, i) => (
          <div className={`rp-uncert sev-${s.severity.toLowerCase()}`} key={i}>
            <h3>
              {s.topic} <span className="rp-sev">{s.severity}</span>
            </h3>
            <p>{s.text}</p>
          </div>
        ))}
        <p className="rp-overall">{data.uncertainty.overall}</p>
      </section>

      {/* MANDATORY — the lineage DAG. */}
      <section className="rp-section rp-break rp-mandatory">
        <h2>Data Provenance</h2>
        <p className="rp-locked">
          This section is always included and cannot be removed from a VARUNA dossier.
        </p>
        <p>{data.provenanceAppendix.lineageNote}</p>
        <table className="rp-table rp-prov">
          <thead>
            <tr>
              <th>Type</th>
              <th>Provider</th>
              <th>Dataset</th>
              <th>External identifier</th>
              <th>Retrieved (UTC)</th>
              <th>Licence</th>
            </tr>
          </thead>
          <tbody>
            {data.provenanceAppendix.records.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.sourceType}</td>
                <td>{r.provider}</td>
                <td className="mono">{r.datasetId}</td>
                <td className="mono rp-id">{r.externalId}</td>
                <td className="mono">{formatUtc(r.retrievedAt)}</td>
                <td>{r.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Run manifest</h3>
        <pre className="rp-manifest mono">{JSON.stringify(data.manifest, null, 2)}</pre>
      </section>
    </main>
  );
}
