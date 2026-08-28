import { useState } from 'react';

/**
 * Version-stamped methodology notes — 06_BACKEND §6.4.5, reused verbatim in the PDF.
 *
 * Every derived number in VARUNA can be interrogated: an analyst who sees "wind
 * suitability 0.5" can find out, in one click, that this means the wind was UNKNOWN rather
 * than measured as marginal. The same text is embedded in the exported report, so the paper
 * dossier explains its own figures without a reader needing the application.
 */
interface Note {
  version: string;
  title: string;
  body: string;
}

export const METHODOLOGY_NOTES: Record<string, Note> = {
  'confidence.model': {
    version: '1.0.0',
    title: 'Model term',
    body:
      'How confident the detector is in the detection itself. A learned segmentation model ' +
      'supplies a calibrated per-pixel oil probability. The classical detector shipped here ' +
      'does not produce one, so this term falls back to the separation evidence and the ' +
      'reported probability is null rather than an invented number.',
  },
  'confidence.separation': {
    version: '1.0.0',
    title: 'Separation term',
    body:
      'How much darker the feature is than the surrounding sea, in decibels. Oil damps short ' +
      'capillary and gravity waves, so a slick returns less energy than open water. Around ' +
      '10 dB of contrast is unambiguous; 3-4 dB is detectable but weaker.',
  },
  'confidence.wind': {
    version: '1.0.0',
    title: 'Wind suitability',
    body:
      'Whether wind conditions permitted detection at all. Below about 3 m/s the sea is glassy ' +
      'and looks dark everywhere, so slicks cannot be distinguished; above about 12 m/s a ' +
      'slick is re-roughened and disappears. The detectable band is roughly 4-9 m/s. When the ' +
      'wind is UNKNOWN this term is 0.5, not 1.0 — an absent measurement is not evidence of ' +
      'good conditions.',
  },
  'confidence.shape': {
    version: '1.0.0',
    title: 'Shape term',
    body:
      'How oil-like the outline is. Real slicks are elongated by wind and current shear and ' +
      'have ragged, low-convexity boundaries. Low-wind zones, rain cells and biogenic films ' +
      'tend to be rounder and smoother. This term is 1 minus the look-alike risk.',
  },
  'area.geodesic': {
    version: '1.0.0',
    title: 'Geodesic area',
    body:
      'Area is computed on the WGS84 ellipsoid, not in degrees and not on a projected map. ' +
      'A degree of longitude shrinks with latitude, so measuring in degree space would ' +
      'overstate area away from the equator. The figure does not change when the outline is ' +
      'simplified for display.',
  },
  'morphology.elongation': {
    version: '1.0.0',
    title: 'Elongation ratio',
    body:
      'Major axis divided by minor axis of the minimum rotated rectangle, measured on a local ' +
      'equal-area projection centred on the feature. Elongation is one of the primary ' +
      'discriminators between a real slick and a look-alike, so it is measured in metres ' +
      'rather than degrees to avoid a latitude-dependent bias.',
  },
  'review.immutability': {
    version: '1.0.0',
    title: 'Why edits create versions',
    body:
      'Confirming, rejecting or correcting a detection never overwrites what the detector ' +
      'produced. Each action adds a version, and version 0 — the original model output — ' +
      'stays retrievable. This output can be used to support an accusation, so it must remain ' +
      'possible to show what the algorithm said before any human adjusted it.',
  },
};

export function MethodologyNote({ id }: { id: keyof typeof METHODOLOGY_NOTES | string }) {
  const [open, setOpen] = useState(false);
  const note = METHODOLOGY_NOTES[id];
  if (!note) return null;

  return (
    <span className="method-note">
      <button
        type="button"
        className="method-trigger"
        aria-expanded={open}
        aria-label={`How ${note.title} is calculated`}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <span className="method-body" role="note">
          <strong>{note.title}</strong>
          <span className="method-version mono">v{note.version}</span>
          <span>{note.body}</span>
        </span>
      ) : null}
    </span>
  );
}
