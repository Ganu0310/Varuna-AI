import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * `/dashboard` — the operations view.
 *
 * What is live across investigations, detections, correlation and the processing queue, in
 * one screen. It answers an operator's question rather than an analyst's: not "which case
 * shall I open?" but "what is this instance actually doing, and is anything stuck?"
 *
 * Every number is SCOPED to what the signed-in account can see, and the scope is printed.
 * An analyst's tiles count their own cases; an admin's count the instance. A count without
 * its denominator is a count nobody can act on.
 */

interface Overview {
  generatedAt: string;
  scope: 'INSTANCE' | 'OWN';
  counts: {
    investigations: number;
    scenes: number;
    detections: number;
    candidates: number;
    jobs: number;
  };
  recentInvestigations: Array<{
    _id: string;
    name: string | null;
    status: string | null;
    aoiAreaKm2: number | null;
    createdAt: string | null;
  }>;
  recentJobs: Array<{
    _id: string;
    kind: string;
    status: string;
    investigationId: string | null;
    progressPct: number | null;
    createdAt: string | null;
  }>;
}

interface Capability {
  key: string;
  label: string;
  state: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'OPTIONAL';
  reason: string;
  consequence: string;
}

interface CapabilityReport {
  overall: Capability['state'];
  capabilities: Capability[];
}

interface VerifiedScenario {
  incidentReference: string;
  name: string;
  bbox: [number, number, number, number];
  acquired: string;
  summary: string;
  stages: string[];
  automated: string[];
  note: string;
}

interface VerifiedRun {
  investigationId: string | null;
  jobId: string | null;
  productId: string | null;
  steps: Array<{ step: string; outcome: 'OK' | 'REUSED' | 'FAILED'; detail: string }>;
  nextSteps: string[];
}

export function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const scenario = useQuery({
    queryKey: ['system', 'verified-scenario'],
    queryFn: () => api.get<VerifiedScenario>('/system/verified-scenario'),
    staleTime: Infinity,
  });

  const run = useMutation({
    mutationFn: () => api.post<VerifiedRun>('/system/verified-scenario', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['system', 'overview'] }),
  });

  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: () => api.get<Overview>('/system/overview'),
    refetchInterval: 30_000,
  });
  const capabilities = useQuery({
    queryKey: ['system', 'capabilities'],
    queryFn: () => api.get<CapabilityReport>('/system/capabilities'),
    refetchInterval: 60_000,
  });

  const o = overview.data;
  const overall = capabilities.data?.overall;
  // The capabilities that are actually costing something, named. "SYSTEM DEGRADED" on its own
  // tells an evaluator that something is wrong and nothing about what.
  const impaired = (capabilities.data?.capabilities ?? []).filter(
    (c) => c.state === 'DEGRADED' || c.state === 'UNAVAILABLE',
  );

  return (
    <main className="page page-wide dashboard">
      <div className="page-head">
        <div>
          <h1>Operations dashboard</h1>
          <p className="muted">
            Live state across investigations, detections, correlation and the processing queue.
            {o ? (
              <>
                {' '}
                Counts cover{' '}
                <strong>
                  {o.scope === 'INSTANCE'
                    ? 'every investigation on this instance'
                    : 'your own investigations'}
                </strong>
                .
              </>
            ) : null}
          </p>
        </div>
        {overall ? (
          <Link className={`status-badge status-${overall.toLowerCase()}`} to="/system">
            SYSTEM {overall}
          </Link>
        ) : null}
      </div>

      {scenario.data ? (
        <section className="card scenario-card">
          <div className="scenario-body">
            <div className="scenario-kicker">VERIFIED SCENARIO</div>
            <h2>{scenario.data.name}</h2>
            <p className="muted">{scenario.data.summary}</p>
            <div className="stage-chips">
              {scenario.data.stages.map((st) => (
                <span
                  key={st}
                  className={`chip ${scenario.data!.automated.includes(st) ? 'chip-auto' : ''}`}
                  title={
                    scenario.data!.automated.includes(st)
                      ? 'Started for you by the button'
                      : 'You run this from the workspace'
                  }
                >
                  {st}
                </span>
              ))}
            </div>
          </div>

          <div className="scenario-action">
            <button className="btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending ? 'Starting…' : 'Run verified Sentinel-1 demo'}
            </button>
            {/*
              The note is not marketing copy — it is the honest scope of the button. It sets
              up and queues the ingest; it does NOT pre-compute the back-track or the ranking,
              because those are the parts an evaluator came to watch happen.
            */}
            <p className="muted scenario-note">{scenario.data.note}</p>
          </div>

          {run.isError ? (
            <div className="panel-error scenario-result" role="alert">
              <strong>Could not start</strong>
              <p>
                {run.error instanceof ApiError
                  ? (run.error.problem?.detail ?? run.error.problem?.title ?? run.error.message)
                  : String(run.error)}
              </p>
            </div>
          ) : null}

          {run.data ? (
            <div className="scenario-result">
              <ul className="scenario-steps">
                {run.data.steps.map((st) => (
                  <li key={st.step}>
                    <span className={`token step-${st.outcome.toLowerCase()}`}>{st.outcome}</span>
                    <span className="mono">{st.step}</span>
                    <span className="muted">{st.detail}</span>
                  </li>
                ))}
              </ul>
              {run.data.investigationId ? (
                <div className="scenario-next">
                  <button
                    className="btn-primary"
                    onClick={() => navigate(`/investigations/${run.data!.investigationId}`)}
                  >
                    Open the workspace
                  </button>
                  <ol className="muted">
                    {run.data.nextSteps.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {impaired.length > 0 ? (
        <section className="card impaired-strip">
          <h2>What is degraded, and what it costs</h2>
          <ul className="impaired-list">
            {impaired.map((c) => (
              <li key={c.key}>
                <span className={`token status-${c.state.toLowerCase()}`}>{c.label}</span>
                <span className="muted"> {c.consequence}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="stat-row">
        {[
          { label: 'Investigations', value: o?.counts.investigations, to: '/investigations' },
          { label: 'Satellite scenes', value: o?.counts.scenes, to: '/catalogue' },
          { label: 'Detections', value: o?.counts.detections, to: null },
          { label: 'Candidate vessels', value: o?.counts.candidates, to: null },
          { label: 'Processing jobs', value: o?.counts.jobs, to: null },
        ].map((s) => (
          <div className="stat-tile" key={s.label}>
            <div className="stat-value">{s.value ?? '—'}</div>
            {s.to ? (
              <Link className="stat-label" to={s.to}>
                {s.label}
              </Link>
            ) : (
              <div className="stat-label">{s.label}</div>
            )}
          </div>
        ))}
      </section>

      <div className="dash-cols">
        <section className="card">
          <div className="card-head">
            <h2>Recent investigations</h2>
            <Link to="/investigations">All</Link>
          </div>
          {o && o.recentInvestigations.length === 0 ? (
            <p className="muted">
              No investigations yet. <Link to="/investigations/new">Create one</Link> to start the
              chain.
            </p>
          ) : (
            <ul className="dash-list">
              {(o?.recentInvestigations ?? []).map((i) => (
                <li key={i._id}>
                  <Link to={`/investigations/${i._id}`}>{i.name ?? '(untitled)'}</Link>
                  <span className="token">{i.status ?? '—'}</span>
                  <span className="mono muted">
                    {i.aoiAreaKm2 !== null
                      ? `${Math.round(i.aoiAreaKm2).toLocaleString()} km²`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Processing queue</h2>
          </div>
          {o && o.recentJobs.length === 0 ? (
            <p className="muted">
              Nothing queued. Jobs appear here when a scene is ingested, a back-track runs, or a
              dossier is rendered.
            </p>
          ) : (
            <ul className="dash-list">
              {(o?.recentJobs ?? []).map((j) => (
                <li key={j._id}>
                  <span className="mono">{j.kind}</span>
                  <span className={`token job-${j.status.toLowerCase()}`}>{j.status}</span>
                  <span className="mono muted">{j.createdAt ? formatUtc(j.createdAt) : ''}</span>
                  {j.investigationId ? (
                    <Link to={`/investigations/${j.investigationId}`}>open</Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
