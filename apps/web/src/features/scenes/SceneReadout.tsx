import type { InspectResponse } from './sceneFile.ts';

/**
 * What the picked file said about itself — 06_BACKEND §6.4.4.
 *
 * One panel, shown wherever a scene file is chosen, so the same file reads the same way
 * whether it is being added to a case or starting one.
 *
 * Every row names the tag or key its value came from, and the extent is labelled a preview.
 * That labelling is not decoration: a footprint drawn on a map is persuasive, and this one is
 * computed from the file header by a reader that deliberately handles only the coordinate
 * systems it can invert exactly. The authoritative geometry comes from the ingest, which can
 * construct a CRS properly, and the two must never be confusable.
 */
export function SceneReadout({ inspection }: { inspection: InspectResponse }) {
  const meta = inspection.metadata;

  return (
    <div className={`scene-read ${inspection.acceptable ? '' : 'scene-read-refused'}`}>
      <div className="scene-read-head">
        <strong>{inspection.acceptable ? 'Read from the file' : 'This file cannot be used'}</strong>
        <span className="token">{inspection.acceptable ? 'GEOREFERENCED' : 'REFUSED'}</span>
      </div>

      {inspection.acceptable ? null : (
        // Verbatim: the reason IS the next action, and it is shown before the upload.
        <p className="scene-read-refusal">{inspection.rejectionReason}</p>
      )}

      <dl className="kv scene-read-kv">
        {meta.platform ? (
          <>
            <dt>Platform</dt>
            <dd className="mono">
              {meta.platform}
              {meta.mode ? ` · ${meta.mode}` : ''}
              {meta.polarisations.length > 0 ? ` · ${meta.polarisations.join('+')}` : ''}
            </dd>
          </>
        ) : null}
        {meta.crs ? (
          <>
            <dt>Coordinate system</dt>
            <dd className="mono" title={meta.crsSource ?? undefined}>
              {meta.crs}
            </dd>
          </>
        ) : null}
        {meta.width && meta.height ? (
          <>
            <dt>Size</dt>
            <dd className="mono">
              {meta.width.toLocaleString()} × {meta.height.toLocaleString()} px
              {meta.bandCount ? ` · ${meta.bandCount} band${meta.bandCount === 1 ? '' : 's'}` : ''}
              {meta.sampleType ? ` · ${meta.sampleType}` : ''}
            </dd>
          </>
        ) : null}
        {meta.gsdMeters ? (
          <>
            <dt>Pixel size</dt>
            <dd className="mono">{meta.gsdMeters.toFixed(1)} m</dd>
          </>
        ) : meta.pixelSize ? (
          <>
            <dt>Pixel size</dt>
            <dd className="mono">
              {meta.pixelSize.x} × {meta.pixelSize.y} (CRS units)
            </dd>
          </>
        ) : null}
        {meta.centre ? (
          <>
            <dt>Centre</dt>
            <dd className="mono">
              {meta.centre.lat.toFixed(3)}°, {meta.centre.lon.toFixed(3)}°
            </dd>
          </>
        ) : null}
        {inspection.aoi ? (
          <>
            <dt>Area of interest</dt>
            <dd className={inspection.aoi.intersects ? 'mono' : 'mono scene-read-warn'}>
              {inspection.aoi.intersects
                ? `${inspection.aoi.aoiCoveredPct}% covered`
                : 'not covered'}
            </dd>
          </>
        ) : null}
      </dl>

      {/* A scene that does not cover the AOI is not an error — it is a wrong file, and saying
          so here saves an ingest and a confusing empty result. */}
      {inspection.aoi && !inspection.aoi.intersects ? (
        <p className="scene-read-warn">{inspection.aoi.note}</p>
      ) : null}

      {meta.footprintNote ? <p className="field-hint">{meta.footprintNote}</p> : null}
      {!meta.readable ? (
        <p className="field-hint">
          The header could not be read from the first{' '}
          {(inspection.bytesInspected / 1024 / 1024).toFixed(1)} MB of this file. It may still be a
          valid GeoTIFF — the upload does the authoritative check.
        </p>
      ) : null}

      <p className="field-hint">{inspection.note}</p>
    </div>
  );
}
