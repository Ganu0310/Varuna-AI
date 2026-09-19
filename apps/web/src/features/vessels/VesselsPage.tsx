import { useState } from 'react';
import { useVessels, useVessel, type VesselIndexRow } from '../../api/hooks.ts';

function Detail({ mmsi }: { mmsi: number }) {
  const q = useVessel(String(mmsi));
  const v = q.data as
    | (Record<string, unknown> & {
        flag?: string | null;
        mmsiValid?: boolean;
        lastSeenAt?: string;
        positionCount?: number;
        source?: string;
        draught?: number | null;
        identity?: { note?: string };
      })
    | undefined;

  if (q.isLoading) return <p className="muted">Loading vessel…</p>;
  if (q.isError || !v) return <p className="form-error">No AIS held for MMSI {mmsi}.</p>;

  return (
    <dl className="kv">
      <dt>MMSI</dt>
      <dd className="mono">{mmsi}</dd>
      <dt>Flag (from MID)</dt>
      <dd>{v.flag ?? 'unresolved'}</dd>
      <dt>MMSI valid</dt>
      <dd>{v.mmsiValid ? 'yes' : 'no'}</dd>
      <dt>Positions held</dt>
      <dd className="mono">{v.positionCount ?? '—'}</dd>
      <dt>Last seen</dt>
      <dd className="mono">{v.lastSeenAt ? new Date(v.lastSeenAt).toISOString() : '—'}</dd>
      <dt>Draught</dt>
      <dd className="mono">{v.draught ?? '—'}</dd>
      <dt>Source</dt>
      <dd>
        {v.source === 'USER_UPLOAD' ? (
          <span className="token status-warn">SYNTHETIC DEMO</span>
        ) : (
          <span className="token">{String(v.source ?? '—')}</span>
        )}
      </dd>
      {v.identity?.note ? (
        <>
          <dt>Identity</dt>
          <dd className="muted">{v.identity.note}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function VesselsPage() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const list = useVessels(q);
  const rows: VesselIndexRow[] = list.data?.items ?? [];

  return (
    <main className="page page-wide dash">
      <header className="page-head">
        <div>
          <h1>Vessel explorer</h1>
          <p className="muted">
            Every MMSI held in the local AIS store. Synthetic demo vessels are marked; nothing here
            is presented as a real observation unless its source says so.
          </p>
        </div>
      </header>

      <section className="card">
        <label htmlFor="vq">Search by MMSI</label>
        <input
          id="vq"
          className="mono"
          inputMode="numeric"
          placeholder="e.g. 538005123"
          value={q}
          onChange={(e) => setQ(e.target.value.replace(/[^\d]/g, ''))}
        />
      </section>

      <div className="split-2">
        <section className="card">
          <div className="card-head">
            <h2>Vessels</h2>
            <span className="muted">{list.data ? `${list.data.total}` : '…'}</span>
          </div>
          {list.isLoading ? (
            <p className="muted">Loading…</p>
          ) : rows.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>MMSI</th>
                  <th>Fixes</th>
                  <th>Span</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.mmsi}
                    className={`is-clickable${selected === r.mmsi ? ' is-selected' : ''}`}
                    onClick={() => setSelected(r.mmsi)}
                  >
                    <td className="mono">{r.mmsi}</td>
                    <td className="mono">{r.fixCount}</td>
                    <td className="mono muted">
                      {r.firstAt ? r.firstAt.slice(0, 16).replace('T', ' ') : '—'} →{' '}
                      {r.lastAt ? r.lastAt.slice(11, 16) : '—'}
                    </td>
                    <td>
                      {r.synthetic ? (
                        <span className="token status-warn">SYNTHETIC</span>
                      ) : (
                        <span className="token">{r.sources[0] ?? '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <p>No vessels in the AIS store yet.</p>
              <p className="field-hint">
                Run the verified demo or import an AIS slice to populate it.
              </p>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Vessel detail</h2>
          </div>
          {selected ? (
            <Detail mmsi={selected} />
          ) : (
            <p className="muted">Select a vessel to see its AIS record and provenance.</p>
          )}
        </section>
      </div>
    </main>
  );
}
