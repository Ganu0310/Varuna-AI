import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateInvestigation } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { formatAreaKm2 } from '../../lib/format.ts';
import { approxPolygonAreaKm2, parsePolygon } from '../../lib/geo.ts';

/**
 * `/investigations/new` — 05_FRONTEND §5.5.4.
 *
 * Phase 2 scope: AOI is pasted as GeoJSON. Map drawing arrives with the map subsystem
 * (Phase 10) and the live catalogue preview with the provider chain (Phase 3) — the
 * preview slot below says so plainly rather than showing a fabricated count.
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
          <label htmlFor="aoi">GeoJSON Polygon — coordinates as [longitude, latitude]</label>
          <textarea
            id="aoi"
            rows={6}
            className="mono"
            spellCheck={false}
            value={aoiText}
            onChange={(e) => setAoiText(e.target.value)}
            placeholder='{"type":"Polygon","coordinates":[[[80.0,13.0],[80.4,13.0],[80.4,13.4],[80.0,13.4],[80.0,13.0]]]}'
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
            Drawing an AOI on the map arrives with the map subsystem. Until then, paste GeoJSON.
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
            05_FRONTEND §5.5.4 calls for a live catalogue preview here so nobody creates an
            investigation with no possible data. That needs the provider chain (Phase 3);
            saying so is the honest interim, rather than showing an invented count.
          */}
          <p className="muted">
            The live catalogue preview — “N Sentinel-1 acquisitions intersect this AOI in this
            window” — is added when the satellite provider chain lands. No scene count is shown
            until it can be queried for real.
          </p>

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
