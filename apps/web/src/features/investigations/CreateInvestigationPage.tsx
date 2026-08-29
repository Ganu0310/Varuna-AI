import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateInvestigation } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { formatAreaKm2 } from '../../lib/format.ts';
import { approxPolygonAreaKm2, parsePolygon } from '../../lib/geo.ts';
import { CataloguePanel } from '../catalogue/CataloguePanel.tsx';

/**
 * `/investigations/new` — 05_FRONTEND §5.5.4.
 *
 * AOI is pasted as GeoJSON; map drawing arrives with the map subsystem (Phase 10).
 * The Review step runs a LIVE catalogue search so nobody creates an investigation for a
 * window with no possible data — every count shown comes from a real provider query.
 */
export function CreateInvestigationPage() {
  const navigate = useNavigate();
  const create = useCreateInvestigation();

  const [name, setName] = useState('');
  const [incidentReference, setIncidentReference] = useState('');
  const [aoiText, setAoiText] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  const parsed = useMemo(() => parsePolygon(aoiText), [aoiText]);

  // Live geodesic-ish area readout so the 50,000 km² cap is visible before submitting.
  const areaKm2 = useMemo(
    () => (parsed.polygon ? approxPolygonAreaKm2(parsed.polygon) : null),
    [parsed.polygon],
  );

  const durationDays = useMemo(() => {
    if (!windowStart || !windowEnd) return null;
    const ms = new Date(windowEnd).getTime() - new Date(windowStart).getTime();
    return Number.isNaN(ms) ? null : ms / 86_400_000;
  }, [windowStart, windowEnd]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.polygon) return;
    create.mutate(
      {
        name,
        incidentReference: incidentReference || undefined,
        aoi: parsed.polygon,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
      },
      { onSuccess: (inv) => navigate(`/investigations/${inv._id}`) },
    );
  };

  const err = create.error instanceof ApiError ? create.error : null;
  const overArea = areaKm2 != null && areaKm2 > 50_000;
  const overWindow = durationDays != null && durationDays > 30;
  const badWindow = durationDays != null && durationDays <= 0;

  return (
    <main className="page">
      <h1>New investigation</h1>

      <form className="stack" onSubmit={onSubmit} noValidate>
        <section className="card">
          <h2>Identify</h2>
          <label htmlFor="name">Name</label>
          <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />

          <label htmlFor="ref">Incident reference (optional)</label>
          <input
            id="ref"
            value={incidentReference}
            onChange={(e) => setIncidentReference(e.target.value)}
          />
        </section>

        <section className="card">
          <h2>Area of interest</h2>
          <label htmlFor="aoi">
            Area of interest — a bounding box, or GeoJSON. Coordinates are [longitude, latitude].
          </label>
          <textarea
            id="aoi"
            rows={6}
            className="mono"
            spellCheck={false}
            value={aoiText}
            onChange={(e) => setAoiText(e.target.value)}
            placeholder="144.55,13.3,144.95,13.6    —  or a GeoJSON Polygon / Feature"
            aria-describedby="aoi-readout"
          />
          <div id="aoi-readout" className="readout" aria-live="polite">
            {aoiText.trim() === '' ? (
              <span className="muted">Paste a GeoJSON Polygon to see its area.</span>
            ) : parsed.error ? (
              <span className="field-error">{parsed.error}</span>
            ) : (
              <>
                <span className="mono">{formatAreaKm2(areaKm2)}</span>{' '}
                {overArea ? (
                  <span className="field-error">
                    — exceeds the 50,000 km² limit. Reduce it by{' '}
                    {formatAreaKm2((areaKm2 ?? 0) - 50_000)}.
                  </span>
                ) : (
                  <span className="muted">— within the 50,000 km² limit</span>
                )}
              </>
            )}
          </div>
          <p className="field-hint">
            Quickest form is a bounding box: <code>west,south,east,north</code> — for example{' '}
            <code>144.55,13.3,144.95,13.6</code> for the Guam demo area. A GeoJSON Polygon, Feature
            or FeatureCollection also works. Drawing directly on the map is not implemented yet.
          </p>
        </section>

        <section className="card">
          <h2>Time window (UTC)</h2>
          <label htmlFor="ws">Start</label>
          <input
            id="ws"
            type="datetime-local"
            required
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
          />
          <label htmlFor="we">End</label>
          <input
            id="we"
            type="datetime-local"
            required
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
          />
          <div className="readout" aria-live="polite">
            {durationDays == null ? (
              <span className="muted">Set both ends to see the duration.</span>
            ) : badWindow ? (
              <span className="field-error">The end must be after the start.</span>
            ) : (
              <>
                <span className="mono">{durationDays.toFixed(1)} days</span>{' '}
                {overWindow ? (
                  <span className="field-error">— exceeds the 30-day maximum.</span>
                ) : (
                  <span className="muted">— within the 30-day maximum</span>
                )}
              </>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Review</h2>
          {/*
            Live provider query (05_FRONTEND §5.5.4). Not auto-run: it consumes a real
            provider quota, so the analyst asks for it explicitly.
          */}
          <CataloguePanel
            aoi={parsed.polygon}
            from={windowStart ? new Date(windowStart).toISOString() : ''}
            to={windowEnd ? new Date(windowEnd).toISOString() : ''}
          />

          <div className="form-error" role="alert" aria-live="polite">
            {create.isError
              ? (err?.problem?.detail ??
                err?.problem?.title ??
                'Could not create the investigation.')
              : ''}
          </div>

          <button
            type="submit"
            disabled={
              create.isPending ||
              !parsed.polygon ||
              overArea ||
              overWindow ||
              badWindow ||
              !name ||
              !windowStart ||
              !windowEnd
            }
          >
            {create.isPending ? 'Creating…' : 'Create investigation'}
          </button>
        </section>
      </form>
    </main>
  );
}
