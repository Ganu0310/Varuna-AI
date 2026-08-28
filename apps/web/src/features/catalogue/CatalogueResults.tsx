import type { CatalogueItem } from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Catalogue results table — 05_FRONTEND §5.5.4 / 04_UIUX §4.8.2.
 *
 * Every row is a real provider record. `productId` is shown verbatim and in full, because
 * it is the identifier an evaluator uses to find the same acquisition themselves
 * (13_REAL_DATA_POLICY §13.9) — it is deliberately not truncated.
 *
 * `onHover` will drive footprint highlighting once the map subsystem lands (Phase 10); the
 * callback exists now so the wiring is a one-line change then.
 */
interface Props {
  items: CatalogueItem[];
  onHover?: (item: CatalogueItem | null) => void;
}

function bytes(n: number | null): string {
  if (n == null) return '—';
  const mb = n / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export function CatalogueResults({ items, onHover }: Props) {
  return (
    <table className="data-table catalogue-table">
      <thead>
        <tr>
          <th>Acquired (UTC)</th>
          <th>Platform</th>
          <th>Mode / Pol.</th>
          <th>Orbit</th>
          <th className="num">AOI overlap</th>
          <th className="num">Size</th>
          <th>Provider</th>
          <th>Product ID</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={`${item.provider}:${item.productId}`}
            onMouseEnter={() => onHover?.(item)}
            onMouseLeave={() => onHover?.(null)}
          >
            <td className="mono">{formatUtc(item.acquiredAt)}</td>
            <td>{item.platform}</td>
            <td className="mono">
              {item.mode ?? '—'}
              {item.polarisations.length > 0 ? ` · ${item.polarisations.join('+')}` : ''}
            </td>
            <td className="mono">{item.orbitDirection ? item.orbitDirection.slice(0, 3) : '—'}</td>
            <td className="num mono">
              {item.aoiOverlapPct == null ? '—' : `${item.aoiOverlapPct.toFixed(0)}%`}
            </td>
            <td className="num mono">{bytes(item.sizeBytes)}</td>
            <td>
              <span className="token">{item.provider}</span>
              {/* RTC products skip ~10 min of SNAP preprocessing per scene (07_AIML §7.2.4). */}
              {item.preprocessed ? (
                <span className="token token-ok" title="Radiometrically terrain corrected">
                  RTC
                </span>
              ) : null}
            </td>
            <td className="mono product-id" title={item.productId}>
              {item.productId}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
