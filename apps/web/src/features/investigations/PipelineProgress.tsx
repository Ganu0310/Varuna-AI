import { Link } from 'react-router-dom';

/**
 * Where this investigation is in the chain, and what to do next.
 *
 * The workspace has seven tabs and no indication of ORDER, but the pipeline is strictly
 * sequential: a scene must be ingested before there are detections, a detection back-tracked
 * before there is an origin, and an origin exists before correlation is allowed at all. An
 * analyst who does not already know that meets a series of empty panels and refusals with no
 * hint of what would fill them.
 *
 * Each step reports its own state from real data — never a stored "progress" field, which
 * would drift from what actually exists the first time anything was deleted or re-run.
 */

export interface PipelineState {
  scenes: number;
  detections: number;
  reviewed: number;
  hasOrigin: boolean;
  originDegraded: boolean;
  candidates: number;
  aisVessels: number;
}

interface Step {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  /** Shown when this is the first incomplete step. */
  next?: string;
  tab?: string;
}

export function buildSteps(s: PipelineState): Step[] {
  return [
    {
      key: 'scene',
      label: 'Ingest a scene',
      done: s.scenes > 0,
      detail: s.scenes > 0 ? `${s.scenes} ingested` : 'none yet',
      next: 'Find an acquisition in Catalogue, then ingest it by product ID.',
      tab: 'catalogue',
    },
    {
      key: 'detect',
      label: 'Detect slicks',
      done: s.detections > 0,
      detail:
        s.detections > 0
          ? `${s.detections} found, ${s.reviewed} reviewed`
          : 'runs automatically on ingest',
      next: 'Detection runs as part of ingest. Watch it in Activity.',
      tab: 'scenes',
    },
    {
      key: 'ais',
      label: 'AIS coverage',
      done: s.aisVessels > 0,
      detail: s.aisVessels > 0 ? `${s.aisVessels} vessels transmitting` : 'no AIS in this window',
      // Not a step an analyst performs — it is a fact about the area, and if it is zero the
      // chain cannot produce candidates however well everything else runs.
      next: 'AIS is imported separately. Without it there is nobody to attribute a slick to.',
      tab: 'ais',
    },
    {
      key: 'origin',
      label: 'Back-track to an origin',
      done: s.hasOrigin,
      detail: s.hasOrigin
        ? s.originDegraded
          ? 'DEGRADED — proximity only'
          : 'drift-derived'
        : 'not run',
      next: 'Pick a detection in Origin and run back-tracking.',
      tab: 'origin',
    },
    {
      key: 'correlate',
      label: 'Rank candidates',
      done: s.candidates > 0,
      detail: s.candidates > 0 ? `${s.candidates} ranked` : 'not run',
      next: 'Needs an origin estimate first — correlation is refused without one.',
      tab: 'candidates',
    },
  ];
}

interface Props {
  state: PipelineState;
  investigationId: string;
  onGoToTab: (tab: string) => void;
}

export function PipelineProgress({ state, investigationId, onGoToTab }: Props) {
  const steps = buildSteps(state);
  const nextIndex = steps.findIndex((s) => !s.done);
  const complete = nextIndex === -1;

  return (
    <section className="pipeline">
      <h3>Progress</h3>
      <ol className="pipeline-steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={`pl-step ${s.done ? 'pl-done' : i === nextIndex ? 'pl-next' : 'pl-todo'}`}
          >
            <button className="pl-label" onClick={() => s.tab && onGoToTab(s.tab)}>
              <span className="pl-mark" aria-hidden="true">
                {s.done ? '✓' : i === nextIndex ? '→' : '·'}
              </span>
              {s.label}
            </button>
            <span className="pl-detail">{s.detail}</span>
          </li>
        ))}
      </ol>

      {complete ? (
        <div className="pl-next-hint">
          <p>Every step has run. The dossier is ready.</p>
          <p className="pl-links">
            <Link to={`/investigations/${investigationId}/report`}>Dossier</Link>
            {' · '}
            <Link to={`/investigations/${investigationId}/prism`}>Space–time prism</Link>
            {' · '}
            <Link to={`/investigations/${investigationId}/relief`}>Slick relief</Link>
          </p>
        </div>
      ) : (
        <div className="pl-next-hint">
          <p>
            <strong>Next:</strong> {steps[nextIndex]!.next}
          </p>
        </div>
      )}
    </section>
  );
}
