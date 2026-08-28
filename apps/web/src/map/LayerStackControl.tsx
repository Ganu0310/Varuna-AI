import { useLayerStore } from '../state/stores.ts';

/**
 * Layer stack — 04_UIUX §4.8.2, 05_FRONTEND §5.4.3.
 *
 * Every layer shows a PROVENANCE CHIP naming where its pixels or geometry came from, and a
 * layer with no provenance cannot be added at all (`useLayerStore.addLayer` refuses it).
 * This is the map-side expression of the same rule as `<DataObject>`: nothing renders
 * without a source, so a screenshot of this map can always be traced back to real data
 * (13_REAL_DATA_POLICY §13.4 L4, MVP M12).
 */
export function LayerStackControl() {
  const { layers, order, toggle, setOpacity, rejectedForNoProvenance } = useLayerStore();
  const present = order
    .map((id) => layers[id])
    .filter((l): l is NonNullable<typeof l> => Boolean(l));

  return (
    <div className="layer-stack">
      <h3>Layers</h3>
      {present.length === 0 ? (
        <p className="muted">No layers yet. Ingest a scene to populate the map.</p>
      ) : null}

      {/* Drawn top-first so the list reads the way the map stacks. */}
      {[...present].reverse().map((l) => (
        <div className="layer-row" key={l.id}>
          <label className="layer-toggle">
            <input type="checkbox" checked={l.visible} onChange={() => toggle(l.id)} />
            <span>{l.label}</span>
          </label>

          <span
            className="prov-chip"
            title={`${l.provenance!.provider} · ${l.provenance!.datasetId}\n${l.provenance!.externalId}\n${l.provenance!.licence}`}
          >
            {l.provenance!.provider}
          </span>

          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={l.opacity}
            onChange={(e) => setOpacity(l.id, Number(e.target.value))}
            aria-label={`${l.label} opacity`}
            disabled={!l.visible}
          />
        </div>
      ))}

      {rejectedForNoProvenance.length > 0 ? (
        <p className="field-error">
          {rejectedForNoProvenance.length} layer(s) were refused because they carried no provenance
          record: {rejectedForNoProvenance.join(', ')}. A layer without a verifiable source cannot
          be drawn.
        </p>
      ) : null}
    </div>
  );
}
