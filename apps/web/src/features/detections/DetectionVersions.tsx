import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

/**
 * The edit history of one detection — 06_BACKEND §6.4.5.
 *
 * Version 0 is the detector's own output and is never overwritten. Review actions append
 * versions; nothing replaces what the algorithm produced.
 *
 * That distinction is the reason this screen exists. A reviewed geometry and a
 * machine-produced one carry different weight, and a reader of the dossier is entitled to
 * see whether the polygon they are looking at came from the detector or from a person
 * redrawing it — and if a person, what they changed and when.
 */

interface Version {
  version: number;
  action: string;
  at: string;
  userId: string | null;
  areaKm2?: number | null;
  note?: string | null;
}

export function DetectionVersions({ detectionId }: { detectionId: string }) {
  const q = useQuery({
    queryKey: ['detection-versions', detectionId],
    queryFn: () =>
      api.get<{ items: Version[]; note?: string }>(`/detections/${detectionId}/versions`),
    enabled: Boolean(detectionId),
  });

  if (q.isLoading) return <p className="muted">Loading history…</p>;
  if (q.isError) return <p className="field-error">Could not load the version history.</p>;

  const items = q.data?.items ?? [];

  return (
    <div className="versions">
      <h4>Version history</h4>
      <ol className="version-list">
        {items.map((v) => (
          <li key={v.version} className={v.version === 0 ? 'version version-origin' : 'version'}>
            <div className="version-head">
              <span className="mono">v{v.version}</span>
              <span className={`token ${v.version === 0 ? 'status-info' : ''}`}>{v.action}</span>
              <span className="muted mono">{formatUtc(v.at)}</span>
            </div>
            {v.areaKm2 != null ? (
              <p className="version-meta mono">{formatAreaKm2(v.areaKm2)}</p>
            ) : null}
            {v.note ? <p className="version-meta">{v.note}</p> : null}
            {v.version === 0 ? (
              <p className="field-hint">
                The detector’s own output, retained unchanged. Every later version is an addition to
                this record, never a replacement of it.
              </p>
            ) : v.userId ? (
              <p className="field-hint mono">by {v.userId.slice(-8)}</p>
            ) : null}
          </li>
        ))}
      </ol>
      {items.length === 1 ? (
        <p className="muted">
          Only the detector’s original output exists — this detection has not been edited.
        </p>
      ) : null}
    </div>
  );
}
