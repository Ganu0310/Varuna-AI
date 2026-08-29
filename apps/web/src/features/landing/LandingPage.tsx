import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * The public front door — 05_FRONTEND §5.5.2.
 *
 * `/` used to redirect straight to `/investigations`, which meant an evaluator arriving at the
 * system met a login form and no explanation of what they were logging into.
 *
 * The page is built around one real, completed incident pulled live from
 * `/api/v1/public/demo-incident`. Not a screenshot, not illustrative figures: numbers an
 * evaluator can go and retrieve. This is the page where a marketing instinct would invent a
 * flattering example, and it is precisely the page where 13_REAL_DATA_POLICY matters most —
 * so it shows the DEGRADED origin estimate and the withheld vessel identities rather than
 * hiding them, because those are the honest parts and honesty is the product.
 *
 * If the endpoint is unconfigured or the API is down, the page says the incident could not be
 * loaded. It does not fall back to a hard-coded example.
 */

interface DemoIncident {
  incident: { name: string; aoiAreaKm2: number; window: { start: string; end: string } };
  scene: {
    productId: string;
    platform: string;
    acquiredAt: string;
    polarisations: string[];
    mode: string;
    gsdMeters: number;
  } | null;
  detections: { areaKm2: number; confidence: number | null; reviewStatus: string }[];
  origin: { status: string; method: string; degradationReason: string | null } | null;
  candidates: {
    rank: number;
    tier: string;
    score: number;
    scoreCI: number[] | null;
    measuredFeatureCount: number;
  }[];
  counts: { scenes: number; detections: number };
  disclaimer: string;
}

export function LandingPage() {
  const demo = useQuery({
    queryKey: ['public', 'demo-incident'],
    queryFn: () => api.get<DemoIncident>('/public/demo-incident'),
    retry: false,
  });

  const d = demo.data;
  const confirmed = d?.detections.filter((x) => x.reviewStatus === 'CONFIRMED').length ?? 0;

  return (
    <main className="landing">
      <header className="landing-hero">
        <p className="landing-eyebrow">SIH26143 · Smart India Hackathon 2026</p>
        <h1>
          Which vessel spilled this oil?
          <span> The evidence, not the accusation.</span>
        </h1>
        <p className="landing-lede">
          VARUNA reads Sentinel-1 radar for oil slicks, back-tracks each slick through ocean
          currents to where it was released, and matches that against AIS vessel tracks — then
          reports how strong the evidence is for each candidate, and what it could not measure.
        </p>
        <div className="landing-cta">
          <Link to="/login" className="btn btn-primary">
            Sign in
          </Link>
          <Link to="/guide" className="btn btn-ghost">
            How it works
          </Link>
        </div>
      </header>

      <section className="landing-principles">
        <article>
          <h2>Real data only</h2>
          <p>
            Every figure traces to a provider product an evaluator can retrieve. Nothing is
            simulated, and an object without provenance is removed rather than shown.
          </p>
        </article>
        <article>
          <h2>Leads, not verdicts</h2>
          <p>
            Candidates are ranked by evidence strength with a confidence interval. Below the
            evidence floor the system withholds a score entirely rather than guessing.
          </p>
        </article>
        <article>
          <h2>It says what it cannot do</h2>
          <p>
            Missing wind, absent currents, a gap in AIS coverage — each is labelled on the result it
            weakens, in the dossier and on this page.
          </p>
        </article>
      </section>

      <section className="landing-incident">
        <h2>A real reconstruction, loaded live</h2>

        {demo.isLoading ? <p className="muted">Loading the incident…</p> : null}

        {demo.isError ? (
          // No hard-coded fallback. A landing page that invents an incident when the API is
          // down is exactly the failure this project is built to avoid.
          <p className="field-error">
            The demo incident could not be loaded. It is served from the live API rather than baked
            into this page, so there is nothing to show while that is unavailable.
          </p>
        ) : null}

        {d ? (
          <>
            <p className="landing-incident-name">{d.incident.name}</p>
            <p className="muted mono">
              {formatUtc(d.incident.window.start)} → {formatUtc(d.incident.window.end)} ·{' '}
              {Math.round(d.incident.aoiAreaKm2).toLocaleString()} km² area of interest
            </p>

            <div className="landing-stats">
              <div>
                <span className="landing-stat">{d.counts.scenes}</span>
                <span className="landing-stat-label">
                  {d.scene ? `${d.scene.platform} scene` : 'scenes'}
                </span>
              </div>
              <div>
                <span className="landing-stat">{d.counts.detections}</span>
                <span className="landing-stat-label">slicks detected</span>
              </div>
              <div>
                <span className="landing-stat">{confirmed}</span>
                <span className="landing-stat-label">confirmed by an analyst</span>
              </div>
              <div>
                <span className="landing-stat">{d.candidates.length}</span>
                <span className="landing-stat-label">candidate vessels ranked</span>
              </div>
            </div>

            {d.scene ? (
              <p className="muted landing-scene mono">
                {d.scene.productId} · {d.scene.mode} · {d.scene.polarisations.join('+')} ·{' '}
                {d.scene.gsdMeters} m · acquired {formatUtc(d.scene.acquiredAt)}
              </p>
            ) : null}

            {d.origin ? (
              <p className={d.origin.status === 'OK' ? 'landing-note' : 'landing-note is-degraded'}>
                <strong>Origin estimate: {d.origin.status}</strong> ({d.origin.method}).{' '}
                {d.origin.degradationReason ??
                  'Both ocean-current and wind forcing were available for this window.'}
              </p>
            ) : null}

            <table className="data-table landing-candidates">
              <caption className="muted">
                Ranked by evidence strength. Vessel identity is withheld on this public page.
              </caption>
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Tier</th>
                  <th className="num">Score</th>
                  <th className="num">Features measured</th>
                </tr>
              </thead>
              <tbody>
                {d.candidates.map((c) => (
                  <tr key={c.rank}>
                    <td className="num mono">{c.rank}</td>
                    <td>
                      <span className="token token-warn">{c.tier}</span>
                    </td>
                    <td className="num mono">
                      {c.score.toFixed(1)}
                      {c.scoreCI ? (
                        <span className="muted">
                          {' '}
                          [{c.scoreCI[0]?.toFixed(0)}–{c.scoreCI[1]?.toFixed(0)}]
                        </span>
                      ) : null}
                    </td>
                    <td className="num mono">{c.measuredFeatureCount}/12</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="landing-disclaimer">{d.disclaimer}</p>
          </>
        ) : null}
      </section>

      <footer className="landing-foot muted">
        Imagery: Copernicus Sentinel-1 via Microsoft Planetary Computer. AIS: NOAA Marine Cadastre.
        Basemap: Natural Earth (public domain).
      </footer>
    </main>
  );
}
