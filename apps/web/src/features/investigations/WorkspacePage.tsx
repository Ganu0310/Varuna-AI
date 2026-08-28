import { useParams } from 'react-router-dom';
import { useInvestigation } from '../../api/hooks.ts';
import { DetectionsPanel } from '../detections/DetectionsPanel.tsx';
import { CataloguePanel } from '../catalogue/CataloguePanel.tsx';
import { formatUtc, formatAreaKm2 } from '../../lib/format.ts';

/**
 * Investigation workspace. The persistent map, layer stack and timeline are Phase 10; this
 * is the working surface over the pipeline that exists: catalogue search, scene ingest,
 * detection and review.
 */
export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { data: inv, isLoading } = useInvestigation(id);

  if (isLoading || !inv)
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>{inv.name}</h1>
          <p className="muted mono">
            {formatAreaKm2(inv.aoiAreaKm2)} · {formatUtc(inv.windowStart)} →{' '}
            {formatUtc(inv.windowEnd)}
          </p>
        </div>
        <span className="token">{inv.status}</span>
      </header>

      <section className="card">
        <h2>Catalogue</h2>
        <CataloguePanel aoi={inv.aoi} from={inv.windowStart} to={inv.windowEnd} />
      </section>

      <DetectionsPanel investigationId={id!} />
    </main>
  );
}
