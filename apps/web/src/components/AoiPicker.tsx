import { AOI_PRESETS, AIS_COVERAGE_LABEL, bboxText, type AoiPreset } from '../lib/aoiPresets.ts';

/**
 * Choose a known area instead of typing coordinates.
 *
 * The dropdown is not just a convenience. Selecting a region commits an analyst to whatever
 * data actually exists there, and for most of the world the answer is "imagery yes, AIS no" —
 * the free bulk archive covers US waters only. So each choice states its AIS situation
 * immediately, rather than letting someone find out after ingesting a scene, running
 * back-tracking and getting an empty candidate list they then have to explain.
 */
interface Props {
  onPick: (bbox: string) => void;
  selectedId: string | null;
}

export function AoiPicker({ onPick, selectedId }: Props) {
  const selected = AOI_PRESETS.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="aoi-picker">
      <label htmlFor="aoi-preset">Known areas</label>
      <select
        id="aoi-preset"
        value={selectedId ?? ''}
        onChange={(e) => {
          const p = AOI_PRESETS.find((x) => x.id === e.target.value);
          if (p) onPick(bboxText(p));
        }}
      >
        <option value="">Choose an area, or type a box below…</option>
        {AOI_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} · {p.region}
          </option>
        ))}
      </select>

      {selected ? (
        <div className={`aoi-preset-note coverage-${selected.aisCoverage.toLowerCase()}`}>
          <span className="token">{AIS_COVERAGE_LABEL[selected.aisCoverage]}</span>
          <p>{selected.note}</p>
        </div>
      ) : (
        <p className="field-hint">
          Areas are taken from the staged demo incident and from the geographic clusters of the 150
          confirmed-oil scenes in the evaluation dataset — so each one is somewhere a slick has
          actually been observed, not a plausible-looking stretch of sea.
        </p>
      )}
    </div>
  );
}

export function presetIdForBbox(text: string): string | null {
  const t = text.trim();
  return AOI_PRESETS.find((p: AoiPreset) => bboxText(p) === t)?.id ?? null;
}
