import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VarunaMark } from '../../components/VarunaMark.tsx';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from '../../api/client.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

/**
 * `/investigations/:id/report/plain` — the same finding, for a reader who has never seen a
 * SAR image or an MMSI before (01_PRD FR-1 F1, extended).
 *
 * The technical dossier is written for someone who can evaluate a confidence interval and
 * knows what "look-alike risk" means. Most of the people this report eventually reaches —
 * a journalist, a district official, a member of the public who asks what happened — are
 * not that reader, and handing them the dossier does not inform them; it just moves the
 * burden of translation onto whoever hands it over, informally, without the caveats
 * surviving the translation.
 *
 * So this is not a shorter dossier. It is a different document built from the SAME numbers:
 * `data.plainSummary` is computed server-side, in `apps/api/src/modules/reports/service.ts`,
 * by walking the same real detections, origin estimate, AIS coverage and candidate rankings
 * the technical sections show — never a separate or softer set of facts. What changes is the
 * form: prose instead of tables, a sentence instead of a tier badge, and every caveat spelled
 * out rather than assumed understood.
 *
 * Two things carry over unconditionally from the dossier, because they are not a matter of
 * audience: this is never presented as a finished determination, and "what we don't know" is
 * never optional. Just as UNCERTAINTY and PROVENANCE cannot be dropped from the technical
 * report, there is no control here that removes the closing caveats.
 */
interface PlainSummary {
  headline: string;
  howThisWasFound: string;
  whatWasSeen: string;
  whereAndWhen: string;
  possibleOrigin: string;
  vesselsIntro: string;
  vessels: Array<{ mmsi: number; rank: number; assessment: string }>;
  whatWeDontKnow: string[];
  bottomLine: string;
}

interface ReportData {
  investigation: {
    _id: string;
    name: string;
    incidentReference?: string;
    windowStart: string;
    windowEnd: string;
    aoiAreaKm2: number;
  };
  plainSummary: PlainSummary;
  generatedAt: string;
}

export function PlainReportPage() {
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    // Same cache entry the technical dossier's own query would use if it requested every
    // section — `plainSummary` rides along on that response rather than a second fetch,
    // so opening both pages back to back costs one request, not two.
    queryKey: ['report', id],
    queryFn: () => api.get<ReportData>(`/investigations/${id}/report/data`),
    enabled: Boolean(id),
  });

  if (isLoading)
    return (
      <main className="report report-plain">
        <p>Preparing summary…</p>
      </main>
    );
  if (isError || !data)
    return (
      <main className="report report-plain">
        <p>Could not build the summary.</p>
      </main>
    );

  const inv = data.investigation;
  const p = data.plainSummary;

  return (
    // data-report-ready is what a headless renderer waits on before capturing the PDF —
    // matched by the worker's own wait for the LAST heading this page renders ("In short").
    <main className="report report-plain" data-report-ready="true">
      <div className="rp-toolbar">
        <Link to={`/investigations/${id}`}>← Workspace</Link>
        <span className="rp-toolbar-sep" aria-hidden="true" />
        <Link to={`/investigations/${id}/report`}>Full technical dossier</Link>
        <span className="rp-toolbar-sep" aria-hidden="true" />
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <span className="rp-toolbar-sep" aria-hidden="true" />
        <button
          className="btn-download"
          title="A ready-made PDF of this page, if one has already been generated"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setDownloadError(null);
            downloadFile(
              `/api/v1/investigations/${id}/report/plain/pdf`,
              `varuna-summary-${id}.pdf`,
            )
              .catch((e) =>
                setDownloadError(
                  e instanceof ApiError
                    ? (e.problem?.detail ?? e.problem?.title ?? e.message)
                    : 'Download failed.',
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <span className="btn-download-icon" aria-hidden="true">
            ↓
          </span>
          {busy ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {downloadError ? (
        <p className="form-error" role="alert">
          {downloadError}
          {downloadError.toLowerCase().includes('no plain-language pdf') ? (
            <>
              {' '}
              Generate one from the <Link to={`/investigations/${id}/report`}>dossier page</Link>,
              or use Print / Save as PDF above instead.
            </>
          ) : null}
        </p>
      ) : null}

      <header className="rp-cover">
        <VarunaMark size={56} />
        <p className="rp-kicker">VARUNA · Plain-language summary</p>
        <h1>{inv.name}</h1>
        {inv.incidentReference ? <p className="rp-ref mono">{inv.incidentReference}</p> : null}
        <p className="pr-lede">{p.headline}</p>
        <dl className="rp-meta">
          <dt>Area searched</dt>
          <dd>{formatAreaKm2(inv.aoiAreaKm2)}</dd>
          <dt>Time period (UTC)</dt>
          <dd className="mono">
            {formatUtc(inv.windowStart)} → {formatUtc(inv.windowEnd)}
          </dd>
          <dt>Prepared</dt>
          <dd className="mono">{formatUtc(data.generatedAt)}</dd>
        </dl>
        <p className="rp-disclaimer">
          This page explains a VARUNA finding in plain language. It is <strong>not</strong> proof
          that a spill happened as described, and it is <strong>not</strong> an accusation against
          any ship named in it. Read "What this report cannot tell you" before repeating anything
          from this page as fact.
        </p>
      </header>

      <section className="rp-section pr-prose">
        <h2>How this finding was made</h2>
        <p>{p.howThisWasFound}</p>
      </section>

      <section className="rp-section pr-prose">
        <h2>What was seen</h2>
        <p>{p.whatWasSeen}</p>
      </section>

      <section className="rp-section pr-prose">
        <h2>Where and when</h2>
        <p>{p.whereAndWhen}</p>
      </section>

      <section className="rp-section pr-prose">
        <h2>Where the oil most likely came from</h2>
        <p>{p.possibleOrigin}</p>
      </section>

      <section className="rp-section pr-break">
        <h2>Ships worth looking into</h2>
        <p className="pr-prose-p">{p.vesselsIntro}</p>
        {p.vessels.length > 0 ? (
          <ol className="pr-vessels">
            {p.vessels.map((v) => (
              <li key={v.mmsi} className="pr-vessel">
                <div className="pr-vessel-head">
                  <span className="pr-vessel-rank">#{v.rank}</span>
                  <span className="mono">Vessel ID (MMSI): {v.mmsi}</span>
                </div>
                <p>{v.assessment}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {/* MANDATORY — no toggle exists for this section, the same way the technical
          dossier's Uncertainty & Limitations cannot be dropped. */}
      <section className="rp-section rp-break rp-mandatory pr-dontknow">
        <h2>What this report cannot tell you</h2>
        <p className="rp-locked">
          This section is always included and cannot be removed from a VARUNA summary.
        </p>
        <ul className="pr-dontknow-list">
          {p.whatWeDontKnow.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      </section>

      <section className="rp-section pr-bottomline">
        <h2>In short</h2>
        <p>{p.bottomLine}</p>
        <p className="pr-technical-pointer">
          Every figure in this summary — the exact coordinates, the satellite product used, each
          ship's full evidence breakdown, and where the underlying data can be independently checked
          — is in the <Link to={`/investigations/${id}/report`}>full technical dossier</Link>.
        </p>
      </section>
    </main>
  );
}
