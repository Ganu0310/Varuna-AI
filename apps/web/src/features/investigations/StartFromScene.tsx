import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_AOI_KM2 } from '@varuna/shared';
import { formatAreaKm2, formatUtc } from '../../lib/format.ts';
import { SceneReadout } from '../scenes/SceneReadout.tsx';
import {
  confidenceToken,
  fromLocalInput,
  inspectSceneFile,
  toLocalInput,
  type InspectResponse,
} from '../scenes/sceneFile.ts';
import { bboxText, deriveScopeFromScene, shrinkToLimit, type DerivedScope } from './fromScene.ts';

/**
 * Start an investigation from the image — 05_FRONTEND §5.5.4.
 *
 * The form below this asks for an area of interest and a time window. For an analyst who was
 * handed a SAR image and told there is a slick in it, both answers are already in the file:
 * the georeferencing says where the radar looked, and the product identifier or metadata says
 * when. Making them retype it was asking them to reconstruct, from memory, something they
 * were holding.
 *
 * So the file is read the moment it is picked, the fields below are filled in from it, and
 * the file itself is carried through creation — it is uploaded to the new investigation and
 * detection runs on it without a second trip through the workspace.
 *
 * Two things it deliberately will not do:
 *
 *  - **Fill in a time window when the file did not state a time.** A window around "now"
 *    would look filled-in and be wrong, and the wrongness surfaces later as a confident
 *    ranking of real vessels that were somewhere else entirely. The weak candidates are
 *    offered, and there is a field to type the real one into; neither happens by itself.
 *  - **Silently shrink an over-large scene to fit.** A full Sentinel-1 swath is bigger than
 *    an investigation may cover. It says so with the number, and taking the centre of the
 *    scene is a button the analyst presses, not something that happens to them.
 *
 * Everything shown is recomputed from one memo over (file, chosen instant, AOI override), so
 * the panel, the fields below and the upload that follows creation cannot disagree about what
 * was decided.
 */
export function StartFromScene({
  onDerive,
  onFileChange,
  disabled,
}: {
  /** Hand the derived scope up to the form, which owns the fields. */
  onDerive: (scope: DerivedScope | null) => void;
  /** The file itself, carried so it can be uploaded once the investigation exists. */
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);
  const [dragging, setDragging] = useState(false);

  /** The acquisition instant in force: the file's own, a candidate accepted, or one typed. */
  const [chosen, setChosen] = useState<{ value: string; source: string } | null>(null);
  const [manual, setManual] = useState('');
  /** Set only when the analyst asks for the centre of an over-large scene. */
  const [aoiOverride, setAoiOverride] = useState<string | null>(null);

  const scope = useMemo<DerivedScope | null>(() => {
    if (!inspection) return null;
    const meta = chosen
      ? { ...inspection.metadata, acquiredAt: chosen.value, acquiredAtSource: chosen.source }
      : inspection.metadata;

    const derived = deriveScopeFromScene(meta, inspection.originalName);
    if (aoiOverride && derived.aoi) {
      return {
        ...derived,
        aoi: {
          text: aoiOverride,
          areaKm2: MAX_AOI_KM2,
          overLimit: false,
          note:
            'The centre of the scene, cut down to the area limit. Everything outside it is ' +
            'still in the file and simply is not being analysed.',
        },
      };
    }
    return derived;
  }, [inspection, chosen, aoiOverride]);

  // The form below owns the fields, so it is told whenever the derivation changes — picking a
  // file, accepting a candidate, typing a time, or trimming the area.
  // `onDerive` sets state in the parent, so it must be referentially stable or this becomes a
  // render loop. The parent memoises it with `useCallback([])` for exactly that reason, which
  // is why it is safe to list here rather than omitted with a suppression.
  useEffect(() => {
    onDerive(scope);
  }, [scope, onDerive]);

  async function read(picked: File) {
    setBusy(true);
    setError(null);
    setInspection(null);
    setChosen(null);
    setManual('');
    setAoiOverride(null);
    onFileChange(null);

    try {
      const result = await inspectSceneFile(picked);
      setInspection(result);
      if (result.metadata.acquiredAt) {
        setChosen({
          value: result.metadata.acquiredAt,
          source: result.metadata.acquiredAtSource ?? 'the file',
        });
      }
      // Carried up only when the bytes are usable. Holding a file the server has already said
      // it will refuse would let someone create an investigation whose one scene is
      // guaranteed to fail — an empty case with a confusing history.
      onFileChange(result.acceptable ? picked : null);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} You can still fill the form in by hand.`
          : 'The file could not be read.',
      );
    } finally {
      setBusy(false);
    }
  }

  function pick(picked: File | null) {
    setFile(picked);
    setError(null);
    if (picked) {
      void read(picked);
    } else {
      setInspection(null);
      setChosen(null);
      setManual('');
      setAoiOverride(null);
      onFileChange(null);
    }
  }

  const meta = inspection?.metadata;
  const suggestions = (meta?.acquisitionCandidates ?? []).filter((c) => c.value !== chosen?.value);

  return (
    <section className="card">
      <h2>Start from a scene</h2>
      <p className="muted">
        Drop a SAR GeoTIFF here and VARUNA reads where it looked and when, fills in the area and the
        window below, and runs detection on it as soon as the investigation exists. Or skip this and
        describe the area yourself.
      </p>

      <div
        className={`scene-drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) pick(dropped);
        }}
      >
        <label htmlFor="start-scene-file">SAR image (GeoTIFF)</label>
        <input
          id="start-scene-file"
          ref={fileRef}
          type="file"
          accept=".tif,.tiff,image/tiff"
          disabled={disabled}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <p className="field-hint">Drag a file onto this panel, or browse for one.</p>
      </div>

      {file ? (
        <p className="field-hint mono">
          {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB ·{' '}
          <button
            type="button"
            className="link-button"
            disabled={disabled || busy}
            onClick={() => {
              if (fileRef.current) fileRef.current.value = '';
              pick(null);
            }}
          >
            remove
          </button>
        </p>
      ) : null}

      {busy ? <p className="field-hint">Reading the file…</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {inspection ? <SceneReadout inspection={inspection} /> : null}

      {scope ? (
        <div className="scene-derived">
          <h3>What was filled in below</h3>

          <div className="scene-derived-row">
            <span className={scope.aoi ? 'token' : 'token token-warn'}>AREA</span>
            {scope.aoi ? (
              <div>
                <p className="mono">
                  {scope.aoi.text} · {formatAreaKm2(scope.aoi.areaKm2)}
                </p>
                <p className={scope.aoi.overLimit ? 'scene-read-warn' : 'field-hint'}>
                  {scope.aoi.note}
                </p>
                {scope.aoi.overLimit ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={disabled}
                    onClick={() => {
                      const bbox = scope.aoi!.text.split(',').map(Number) as [
                        number,
                        number,
                        number,
                        number,
                      ];
                      setAoiOverride(bboxText(shrinkToLimit(bbox)));
                    }}
                  >
                    Use the centre of the scene
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="scene-read-warn">{scope.aoiBlocker}</p>
            )}
          </div>

          <div className="scene-derived-row">
            <span className={scope.window ? 'token' : 'token token-warn'}>WINDOW</span>
            <div>
              {scope.window ? (
                <>
                  <p className="mono">
                    {scope.window.start.replace('T', ' ')} → {scope.window.end.replace('T', ' ')}{' '}
                    UTC
                  </p>
                  <p className="field-hint">{scope.window.note}</p>
                </>
              ) : (
                <p className="scene-read-warn">{scope.windowBlocker}</p>
              )}

              {/* Weak signals are offered, never adopted. One click sets the window around a
                  time the analyst has decided to believe — a different act from the form
                  having decided for them. */}
              {suggestions.length > 0 ? (
                <ul className="scene-read-candidates-list">
                  {suggestions.map((c) => (
                    <li key={`${c.value}-${c.source}`}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={disabled}
                        onClick={() => setChosen({ value: c.value, source: c.source })}
                      >
                        Use {formatUtc(c.value)}
                      </button>
                      <span className={confidenceToken(c.confidence)}>{c.confidence}</span>
                      <span className="scene-read-source">{c.source}</span>
                      <span className="field-hint">{c.note}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The last resort, and often the right one: the analyst has the acquisition
                  time from the delivery note and the file simply does not carry it. Without
                  this field a perfectly good scene could not be uploaded here at all. */}
              {!scope.window ? (
                <div className="scene-manual-time">
                  <label htmlFor="start-acquired-at">Or enter the acquisition time (UTC)</label>
                  <input
                    id="start-acquired-at"
                    type="datetime-local"
                    value={manual}
                    disabled={disabled}
                    onChange={(e) => {
                      setManual(e.target.value);
                      setChosen(
                        e.target.value
                          ? { value: fromLocalInput(e.target.value), source: 'entered by you' }
                          : null,
                      );
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <p className="field-hint">
            All of it is editable below — this is what the file says, not a decision.
            {scope.acquiredAt
              ? ` The scene will be uploaded to the new investigation dated ${toLocalInput(
                  scope.acquiredAt,
                ).replace('T', ' ')} UTC (${scope.acquiredAtSource}).`
              : ' Without an acquisition time the scene cannot be uploaded, so the investigation' +
                ' would be created empty.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
