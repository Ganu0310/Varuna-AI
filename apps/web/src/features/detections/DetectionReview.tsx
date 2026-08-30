import { useState } from 'react';
import {
  useDetection,
  useDetectionVersions,
  useRejectionCategories,
  useReviewDetection,
  type Detection,
} from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { MethodologyNote } from '../../components/MethodologyNote.tsx';
import { formatUtc, formatAreaKm2, formatDistanceKm, formatBearing } from '../../lib/format.ts';

/**
 * Detection review — 05_FRONTEND §5.5.6.
 *
 * Two things this screen must never do: present a single confidence number without its
 * parts, and let a correction quietly replace what the detector said. The confidence panel
 * therefore shows four separate bars each with its raw value and a methodology note, and
 * the version list shows the model's original output alongside every human action.
 */
interface Props {
  detectionId: string;
  investigationId?: string;
  onClose?: () => void;
}

const TERMS = [
  { key: 'modelTerm', label: 'Model', note: 'confidence.model' },
  { key: 'separationTerm', label: 'Separation', note: 'confidence.separation' },
  { key: 'windTerm', label: 'Wind suitability', note: 'confidence.wind' },
  { key: 'shapeTerm', label: 'Shape', note: 'confidence.shape' },
] as const;

function rawFor(key: string, d: Detection): string {
  switch (key) {
    case 'modelTerm':
      return d.confidence.meanOilProbability == null
        ? 'no calibrated probability'
        : d.confidence.meanOilProbability.toFixed(2);
    case 'windTerm':
      // 0.5 is the sentinel for "unknown", and saying so is the whole point of the panel.
      return d.confidence.windSuitability === 0.5
        ? 'wind unknown'
        : `${d.confidence.windSuitability.toFixed(2)}`;
    case 'shapeTerm':
      return `look-alike risk ${d.confidence.lookAlikeCompetition.toFixed(2)}`;
    default:
      return '—';
  }
}

export function DetectionReview({ detectionId, investigationId, onClose }: Props) {
  const { data: d, isLoading } = useDetection(detectionId);
  const { data: versions } = useDetectionVersions(detectionId);
  const { data: categories } = useRejectionCategories();
  const review = useReviewDetection(investigationId);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('');

  if (isLoading || !d) return <p className="muted">Loading detection…</p>;

  const err = review.error instanceof ApiError ? review.error : null;
  const rejecting = review.variables?.action === 'REJECT';

  const chosen = (categories?.items ?? []).find((c) => c.id === category);
  const canReject = Boolean(note.trim() && category);
  // The two kinds are grouped rather than listed flat, because the choice between them is
  // the one an analyst gets wrong: "duplicate" and "rain cell" both feel like reasons, and
  // only one of them is a statement about the imagery.
  const lookAlikes = (categories?.items ?? []).filter((c) => c.kind === 'LOOK_ALIKE');
  const operational = (categories?.items ?? []).filter((c) => c.kind === 'OPERATIONAL');

  return (
    <section className="detection-review">
      <header className="dr-head">
        <div>
          <h2>
            Detection <span className="mono">{formatAreaKm2(d.areaKm2)}</span>
            <MethodologyNote id="area.geodesic" />
          </h2>
          <p className="muted mono">
            {d.model.name} v{d.model.version} · artefact{' '}
            <span className="hash">{d.model.artefactSha256}</span>
          </p>
        </div>
        <span className={`token status-${d.reviewStatus.toLowerCase()}`}>{d.reviewStatus}</span>
        {onClose ? (
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <div className="dr-grid">
        <div className="card">
          <h3>Confidence</h3>
          {/* Four separate terms — never one opaque number (07_AIML §7.2.11). */}
          {TERMS.map((t) => {
            const v = (d.confidence[t.key] as number | undefined) ?? null;
            return (
              <div className="conf-row" key={t.key}>
                <span className="conf-label">
                  {t.label}
                  <MethodologyNote id={t.note} />
                </span>
                <span className="conf-bar" aria-hidden="true">
                  <span className="conf-fill" style={{ width: `${(v ?? 0) * 100}%` }} />
                </span>
                <span className="mono conf-value">{v == null ? '—' : v.toFixed(2)}</span>
                <span className="muted conf-raw">{rawFor(t.key, d)}</span>
              </div>
            );
          })}
          <div className="conf-overall mono">overall {d.confidence.overall.toFixed(2)}</div>
          {d.confidence.windSuitability === 0.5 ? (
            <p className="field-hint">
              Wind at acquisition was not available, so the wind term reports 0.5 (unknown) rather
              than assuming favourable conditions. Confidence is correspondingly capped.
            </p>
          ) : null}
        </div>

        <div className="card">
          <h3>Morphology</h3>
          <dl className="kv">
            <dt>
              Elongation
              <MethodologyNote id="morphology.elongation" />
            </dt>
            <dd className="mono">{d.morphology.elongationRatio.toFixed(2)}</dd>
            <dt>Major axis</dt>
            <dd className="mono">{formatDistanceKm(d.morphology.majorAxisKm)}</dd>
            <dt>Minor axis</dt>
            <dd className="mono">{formatDistanceKm(d.morphology.minorAxisKm)}</dd>
            <dt>Orientation</dt>
            <dd className="mono">{formatBearing(d.morphology.orientationDeg)}</dd>
            <dt>Convexity</dt>
            <dd className="mono">{d.morphology.convexity.toFixed(2)}</dd>
            <dt>Perimeter</dt>
            <dd className="mono">{formatDistanceKm(d.perimeterKm)}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h3>
          Review <MethodologyNote id="review.immutability" />
        </h3>
        <label htmlFor="dr-note">
          Note {rejecting ? <span className="req">(required to reject)</span> : '(optional)'}
        </label>
        <textarea
          id="dr-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Wind shadow behind the headland, not oil."
        />

        {/*
         * The category is required to reject, alongside the note, and the two do different
         * jobs: the note explains this decision to the next person reading this case; the
         * category is the same decision in a form that counts across cases and becomes a
         * labelled negative the detector can be retrained on. The detector fires on 68% of
         * look-alike scenes with its own warning reading 0.26 — this is where the data that
         * fixes that comes from, and it only exists if it is captured at the moment of the
         * judgement.
         */}
        <label htmlFor="dr-category">
          What was it? <span className="req">(required to reject)</span>
        </label>
        <select
          id="dr-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-describedby="dr-category-hint"
        >
          <option value="">Choose a category…</option>
          <optgroup label="Not oil — a statement about the imagery">
            {lookAlikes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Operational — not about the imagery">
            {operational.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
        </select>
        <p className="field-hint" id="dr-category-hint">
          {chosen ? (
            <>
              {chosen.description}{' '}
              {chosen.sarClass ? (
                <strong>
                  Recorded as a labelled <code>{chosen.sarClass}</code> negative for detector
                  training.
                </strong>
              ) : (
                <strong>
                  Recorded on the case, and not used as a training label — this says nothing about
                  what the detector saw.
                </strong>
              )}
            </>
          ) : (
            'Naming the mechanism is what turns a rejection into evidence about the detector rather than only about this case.'
          )}
        </p>

        <div className="form-error" role="alert" aria-live="polite">
          {review.isError ? (err?.problem?.detail ?? 'Review failed.') : ''}
        </div>
        <div className="dr-actions">
          <button
            onClick={() =>
              review.mutate({ id: detectionId, action: 'CONFIRM', note: note || undefined })
            }
            disabled={review.isPending}
          >
            Confirm
          </button>
          <button
            className="btn-danger"
            onClick={() =>
              review.mutate({
                id: detectionId,
                action: 'REJECT',
                note,
                rejectionCategory: category,
              })
            }
            disabled={review.isPending || !canReject}
            title={canReject ? undefined : 'Rejecting needs both a reason and a category'}
          >
            Reject
          </button>
          <button
            className="btn-ghost"
            onClick={() =>
              review.mutate({ id: detectionId, action: 'REOPEN', note: note || undefined })
            }
            disabled={review.isPending || d.reviewStatus === 'UNREVIEWED'}
          >
            Reopen
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Versions</h3>
        <p className="muted">{versions?.note}</p>
        <ol className="versions">
          {(versions?.items ?? []).map((v) => (
            <li key={v.version} className={v.isModelOutput ? 'v-model' : ''}>
              <span className="token">{v.isModelOutput ? 'MODEL OUTPUT' : v.action}</span>
              <span className="mono muted">{formatUtc(v.at)}</span>
              {v.rejectionCategory ? <span className="token">{v.rejectionCategory}</span> : null}
              {v.note ? <span className="v-note">“{v.note}”</span> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
