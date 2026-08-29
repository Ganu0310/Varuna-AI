import { useState } from 'react';
import { CataloguePanel } from './CataloguePanel.tsx';
import { ProviderHealthTable } from './ProviderHealthTable.tsx';
import { parsePolygon } from '../../lib/geo.ts';
import { AoiPicker, presetIdForBbox } from '../../components/AoiPicker.tsx';

/**
 * `/catalogue` — a standalone live catalogue search, so an analyst can check coverage
 * before committing to an investigation (06_BACKEND §6.4.3).
 */
export function CataloguePage() {
  const [aoiText, setAoiText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const parsed = parsePolygon(aoiText);
  const iso = (v: string) => (v ? new Date(v).toISOString() : '');

  return (
    <main className="page">
      <h1>Catalogue</h1>
      <p className="muted">
        Live search across the Copernicus Data Space, Microsoft Planetary Computer and ASF DAAC
        catalogues. Results are not stored.
      </p>

      <section className="card">
        <AoiPicker onPick={setAoiText} selectedId={presetIdForBbox(aoiText)} />

        <label htmlFor="aoi">
          Area of interest — a bounding box (<code>west,south,east,north</code>) or GeoJSON
        </label>
        <textarea
          id="aoi"
          rows={4}
          className="mono"
          spellCheck={false}
          value={aoiText}
          onChange={(e) => setAoiText(e.target.value)}
          placeholder='{"type":"Polygon","coordinates":[[[80.0,13.0],[80.6,13.0],[80.6,13.4],[80.0,13.4],[80.0,13.0]]]}'
        />
        <div className="field-error">{parsed.error ?? ''}</div>

        <label htmlFor="from">From (UTC)</label>
        <input
          id="from"
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label htmlFor="to">To (UTC)</label>
        <input id="to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      </section>

      <section className="card">
        <h2>Results</h2>
        <CataloguePanel aoi={parsed.polygon} from={iso(from)} to={iso(to)} />
      </section>

      <section className="card">
        <h2>Provider health</h2>
        <ProviderHealthTable />
      </section>
    </main>
  );
}
