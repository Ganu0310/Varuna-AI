import type { ReactNode } from 'react';
import { hasValidProvenance } from '../lib/provenance.ts';

interface Props {
  value: unknown;
  typeName: string;
  children: ReactNode;
}

/**
 * Provenance boundary (04_UIUX §4.8.2, 05_FRONTEND §5.7, 13_REAL_DATA_POLICY §13.4 L4).
 * If a child's data lacks a verifiable source record it renders a red PROVENANCE MISSING
 * panel INSTEAD of the data. The failure state is deliberately ugly and unmissable — a
 * broken layout is a better outcome than an unsourced number.
 */
export function DataObject({ value, typeName, children }: Props) {
  const stripped = (value as { __provenanceMissing?: boolean })?.__provenanceMissing === true;
  const ok = !stripped && hasValidProvenance(value);

  if (!ok) {
    const id = (value as { _id?: string })?._id;
    return (
      <div role="alert" className="provenance-missing" data-testid="provenance-missing">
        <strong>PROVENANCE MISSING</strong>
        <p>{typeName} cannot be displayed because it has no verifiable source record.</p>
        {id ? <code>{id}</code> : null}
      </div>
    );
  }
  return <>{children}</>;
}
