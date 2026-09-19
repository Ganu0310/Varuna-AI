import { useIntegrations, type Integration } from '../../api/hooks.ts';

function statusToken(i: Integration) {
  if (i.configured) return <span className="token status-ok">CONNECTED</span>;
  if (i.required) return <span className="token status-danger">REQUIRED — NOT CONFIGURED</span>;
  return <span className="token status-warn">OPTIONAL — NOT CONFIGURED</span>;
}

const GROUPS: { key: string; title: string; blurb: string }[] = [
  {
    key: 'satellite',
    title: 'Satellite imagery',
    blurb: 'Sources for Sentinel-1 discovery and RTC access.',
  },
  {
    key: 'forcing',
    title: 'Ocean & atmosphere forcing',
    blurb: 'Currents and winds for origin back-tracking.',
  },
  { key: 'ais', title: 'Vessel traffic (AIS)', blurb: 'Position feeds for correlation.' },
];

export function SettingsPage() {
  const q = useIntegrations();
  const items = q.data?.items ?? [];

  return (
    <main className="page dash">
      <header className="page-head">
        <div>
          <h1>Settings — data sources</h1>
          <p className="muted">
            Which external providers are configured for this deployment. Secret values are never
            shown; configuration is set through environment variables (see{' '}
            <span className="mono">docs/DATA-AND-CREDENTIALS.md</span>).
          </p>
        </div>
      </header>

      {q.isLoading ? (
        <section className="card">
          <p className="muted">Loading…</p>
        </section>
      ) : (
        GROUPS.map((g) => {
          const rows = items.filter((i) => i.category === g.key);
          if (!rows.length) return null;
          return (
            <section className="card" key={g.key}>
              <div className="card-head">
                <h2>{g.title}</h2>
              </div>
              <p className="muted">{g.blurb}</p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>State</th>
                    <th>Enables</th>
                    <th>Provider page</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.key}>
                      <td>{i.label}</td>
                      <td>{statusToken(i)}</td>
                      <td className="muted">{i.enables}</td>
                      <td className="mono">
                        <a href={i.docs} target="_blank" rel="noreferrer">
                          {i.docs.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}

      <section className="card">
        <h2>Current demo posture</h2>
        <ul className="plain-list">
          <li>
            <span className="token status-ok">REAL</span> Sentinel-1C RTC scene via Microsoft
            Planetary Computer — works with no credentials.
          </li>
          <li>
            <span className="token status-warn">SYNTHETIC</span> AIS — a deterministic labelled demo
            slice; provenance never claims a real source.
          </li>
          <li>
            <span className="token status-warn">DEGRADED</span> Origin back-track — no keyless
            ocean/wind model covers the demo date; configure Copernicus Marine + CDS to enable full
            back-tracking.
          </li>
        </ul>
      </section>
    </main>
  );
}
