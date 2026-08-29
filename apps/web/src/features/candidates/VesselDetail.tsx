import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * What is actually known about a vessel — 06_BACKEND §6.4.7.
 *
 * A candidate list names MMSIs, and an MMSI on its own is not an identification. This shows
 * how much identity the archive really supports, which for a bulk historical export is
 * usually: a number, a flag derived from its MID prefix, and nothing else.
 *
 * That emptiness is the point rather than a gap to apologise for. Several attribution
 * features (vessel type prior, prior incident history) report MISSING precisely because this
 * data is absent, and an analyst about to act on a ranking should see the same void the
 * scoring model saw.
 */

interface Vessel {
  mmsi: number;
  flag: string | null;
  mmsiValid: boolean;
  identity: {
    name: string | null;
    imo: string | null;
    callsign: string | null;
    shipType: string | null;
    note?: string | null;
  };
  lastSeenAt: string | null;
  lastPosition: { type: 'Point'; coordinates: [number, number] } | null;
  draught: number | null;
  positionCount: number;
  source: string;
  qualityFlags: string[];
}

export function VesselDetail({ mmsi }: { mmsi: number }) {
  const q = useQuery({
    queryKey: ['vessel', mmsi],
    queryFn: () => api.get<Vessel>(`/ais/vessel/${mmsi}`),
    enabled: Boolean(mmsi),
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return <p className="muted">Loading vessel…</p>;
  if (q.isError || !q.data) return <p className="field-error">Could not load this vessel.</p>;

  const v = q.data;
  // Not "unknown" and never blank: the archive genuinely does not carry these fields, which
  // is a different statement from "we did not look".
  const absent = <span className="muted">not in this archive</span>;

  return (
    <div className="vessel-detail">
      <h4>
        <span className="mono">{v.mmsi}</span>
        {v.mmsiValid ? (
          <span className="token status-ok">MMSI VALID</span>
        ) : (
          // An MMSI whose prefix is not an assigned country is reported as invalid rather
          // than given a plausible-looking flag.
          <span className="token status-danger">MMSI INVALID</span>
        )}
      </h4>

      <dl className="kv">
        <dt>Flag</dt>
        <dd>{v.flag ?? absent}</dd>
        <dt>Name</dt>
        <dd>{v.identity.name ?? absent}</dd>
        <dt>IMO</dt>
        <dd className="mono">{v.identity.imo ?? absent}</dd>
        <dt>Call sign</dt>
        <dd className="mono">{v.identity.callsign ?? absent}</dd>
        <dt>Ship type</dt>
        <dd>{v.identity.shipType ?? absent}</dd>
        <dt>Draught</dt>
        <dd className="mono">{v.draught == null ? absent : `${v.draught} m`}</dd>
        <dt>Positions</dt>
        <dd className="mono">{v.positionCount.toLocaleString()}</dd>
        <dt>Last seen</dt>
        <dd className="mono">{v.lastSeenAt ? formatUtc(v.lastSeenAt) : '—'}</dd>
        <dt>Last position</dt>
        <dd className="mono">
          {v.lastPosition
            ? `${v.lastPosition.coordinates[1].toFixed(4)}, ${v.lastPosition.coordinates[0].toFixed(4)}`
            : '—'}
        </dd>
        <dt>Source</dt>
        <dd className="mono">{v.source}</dd>
      </dl>

      {v.identity.note ? <p className="field-hint">{v.identity.note}</p> : null}

      {v.qualityFlags.length > 0 ? (
        <p className="field-hint">
          Quality flags: <span className="mono">{v.qualityFlags.join(', ')}</span>
        </p>
      ) : null}
    </div>
  );
}
