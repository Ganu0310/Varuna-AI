import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateInvestigation } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { formatAreaKm2 } from '../../lib/format.ts';
import { approxPolygonAreaKm2, parsePolygon } from '../../lib/geo.ts';
import { CataloguePanel } from '../catalogue/CataloguePanel.tsx';
import { AoiPicker, presetIdForBbox } from '../../components/AoiPicker.tsx';
import { fromLocalInput, uploadSceneFile } from '../scenes/sceneFile.ts';
import { StartFromScene } from './StartFromScene.tsx';
import type { DerivedScope } from './fromScene.ts';

/**
 * `/investigations/new` — 05_FRONTEND §5.5.4.
 *
 * AOI is pasted as GeoJSON; map drawing arrives with the map subsystem (Phase 10).
 * The Review step runs a LIVE catalogue search so nobody creates an investigation for a
 * window with no possible data — every count shown comes from a real provider query.
 *
 * There are two ways in, and the second is the one an analyst usually arrives with. Either
 * describe the area and window and go looking for imagery, or drop the image you were handed
 * and let it describe them: `StartFromScene` reads the file, fills these fields in from what
 * it says, and the file is then carried through creation and uploaded to the new case, so
 * detection starts without a second trip through the workspace.
 */
export function CreateInvestigationPage() {
  const navigate = useNavigate();
  const create = useCreateInvestigation();

  const [name, setName] = useState('');
  const [incidentReference, setIncidentReference] = useState('');
  const [aoiText, setAoiText] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  /** The scene to attach, and the acquisition instant the fields below were derived from. */
  const [sceneFile, setSceneFile] = useState<File | null>(null);
  const [sceneScope, setSceneScope] = useState<DerivedScope | null>(null);
  const [uploading, setUploading] = useState(false);
  /**
   * Creation succeeded and the upload did not.
   *
   * Kept separately from the create error because it is a different situation with a
   * different next action: the investigation EXISTS. Saying only "upload failed" would leave
   * the analyst on a form, retrying, quietly making a second case each time.
   */
  const [partial, setPartial] = useState<{ id: string; message: string } | null>(null);

  /**
   * Fill the fields from what the file said.
   *
   * Overwrites rather than merges. The analyst pressed a control called "start from a scene",
   * and a form that kept half of a previous answer would be showing a scope that came from
   * two places at once — which is exactly the kind of thing nobody notices until the AIS
   * query comes back wrong.
   */
  const applyScope = useCallback((scope: DerivedScope | null) => {
    setSceneScope(scope);
    setPartial(null);
    if (!scope) return;
    setName(scope.name);
    if (scope.aoi) setAoiText(scope.aoi.text);
    if (scope.window) {
      setWindowStart(scope.window.start);
      setWindowEnd(scope.window.end);
    }
  }, []);

  const parsed = useMemo(() => parsePolygon(aoiText), [aoiText]);

  // Live geodesic-ish area readout so the 50,000 km² cap is visible before submitting.
  const areaKm2 = useMemo(
    () => (parsed.polygon ? approxPolygonAreaKm2(parsed.polygon) : null),
    [parsed.polygon],
  );

  const durationDays = useMemo(() => {
    if (!windowStart || !windowEnd) return null;
    const ms = Date.parse(fromLocalInput(windowEnd)) - Date.parse(fromLocalInput(windowStart));
    return Number.isNaN(ms) ? null : ms / 86_400_000;
  }, [windowStart, windowEnd]);

  /**
   * Create, then attach the scene, then open the workspace.
   *
   * Two requests, in that order, because the upload needs an investigation to belong to. The
   * failure between them is handled explicitly rather than swallowed: if the scene is
   * refused, the case still exists and the analyst is told so and given the link, because the
   * alternative — an error that looks like nothing happened — leads to a second case, and a
   * third.
   */
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.polygon) return;
    setPartial(null);

    let inv;
    try {
      inv = await create.mutateAsync({
        name,
        incidentReference: incidentReference || undefined,
        aoi: parsed.polygon,
        // The heading says UTC and every instant this app shows is labelled Z, so the value
        // is read as UTC. Reading it as the browser's local time would shift the window — and
        // the AIS search inside it — by hours for most of the world.
        windowStart: fromLocalInput(windowStart),
        windowEnd: fromLocalInput(windowEnd),
      });
    } catch {
      return; // rendered from `create.error` below
    }

    if (!sceneFile) {
      navigate(`/investigations/${inv._id}`);
      return;
    }

    setUploading(true);
    try {
      // The same instant the window was drawn around — passed explicitly rather than
      // re-derived, so the scene cannot end up dated differently from its own case.
      await uploadSceneFile(inv._id, sceneFile, sceneScope?.acquiredAt ?? undefined);
      navigate(`/investigations/${inv._id}`);
    } catch (err) {
      setPartial({
        id: inv._id,
        message: err instanceof Error ? err.message : 'The scene could not be accepted.',
      });
    } finally {
      setUploading(false);
    }
  };

  const err = create.error instanceof ApiError ? create.error : null;
  const overArea = areaKm2 != null && areaKm2 > 50_000;
  const overWindow = durationDays != null && durationDays > 30;
  const badWindow = durationDays != null && durationDays <= 0;

  return (
    <main className="page">
      <h1>New investigation</h1>

      <form className="stack" onSubmit={onSubmit} noValidate>
        <StartFromScene
          onDerive={applyScope}
          onFileChange={setSceneFile}
          disabled={create.isPending || uploading}
        />

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
          <AoiPicker onPick={setAoiText} selectedId={presetIdForBbox(aoiText)} />

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
          {sceneScope?.window ? (
            // Once a scene has derived a real window, a pair of editable raw fields sitting
            // right below `StartFromScene`'s own "what was filled in" summary would be two
            // sources for the same value — and the one an analyst edits by habit is the one
            // that stops matching what was actually derived. The derivation IS the field here;
            // typing a different window means removing the scene first, not overwriting this.
            <div className="readout" aria-live="polite">
              <span className="mono">
                {sceneScope.window.start.replace('T', ' ')} →{' '}
                {sceneScope.window.end.replace('T', ' ')}
              </span>{' '}
              <span className="muted">
                — taken from the scene ({sceneScope.acquiredAtSource}). Remove the file above to set
                a window by hand instead.
              </span>
            </div>
          ) : (
            <>
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
            </>
          )}
        </section>

        <section className="card">
          <h2>Review</h2>
          {/*
            Live provider query (05_FRONTEND §5.5.4). Not auto-run: it consumes a real
            provider quota, so the analyst asks for it explicitly.
          */}
          <CataloguePanel
            aoi={parsed.polygon}
            from={windowStart ? fromLocalInput(windowStart) : ''}
            to={windowEnd ? fromLocalInput(windowEnd) : ''}
          />

          {sceneFile ? (
            <p className="field-hint">
              <strong>{sceneFile.name}</strong> will be uploaded to the new investigation and
              detection will start on it immediately.
            </p>
          ) : null}

          <div className="form-error" role="alert" aria-live="polite">
            {create.isError
              ? (err?.problem?.detail ??
                err?.problem?.title ??
                'Could not create the investigation.')
              : ''}
          </div>

          {/* The half-succeeded case, stated as such. The investigation is real and reachable;
              only the scene did not land, and that is what the analyst has to act on. */}
          {partial ? (
            <div className="panel-error" role="alert">
              <strong>The investigation was created, but the scene was not accepted.</strong>
              <p>{partial.message}</p>
              <p>
                <Link to={`/investigations/${partial.id}`}>
                  Open the investigation and add a scene there →
                </Link>
              </p>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={
              create.isPending ||
              uploading ||
              Boolean(partial) ||
              !parsed.polygon ||
              overArea ||
              overWindow ||
              badWindow ||
              !name ||
              !windowStart ||
              !windowEnd
            }
          >
            {uploading
              ? 'Uploading the scene…'
              : create.isPending
                ? 'Creating…'
                : sceneFile
                  ? 'Create and analyse the scene'
                  : 'Create investigation'}
          </button>
        </section>
      </form>
    </main>
  );
}
