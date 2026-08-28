import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataObject } from './DataObject.tsx';
import { assertProvenance, ProvenanceError } from '../lib/provenance.ts';

const validProvenance = {
  sourceType: 'SATELLITE_SCENE',
  provider: 'Copernicus Data Space Ecosystem',
  datasetId: 'SENTINEL-1',
  externalId: 'S1A_IW_GRDH_...',
  retrievedAt: '2026-02-14T09:20:31Z',
  licence: 'Copernicus Sentinel Data 2023',
};

describe('<DataObject>', () => {
  it('renders children when provenance is valid', () => {
    render(
      <DataObject typeName="SatelliteScene" value={{ _id: 's1', provenance: validProvenance }}>
        <span>18.42 km²</span>
      </DataObject>,
    );
    expect(screen.getByText('18.42 km²')).toBeInTheDocument();
    expect(screen.queryByTestId('provenance-missing')).not.toBeInTheDocument();
  });

  it('renders the loud PROVENANCE MISSING panel when provenance is absent', () => {
    render(
      <DataObject typeName="SatelliteScene" value={{ _id: 's2' }}>
        <span>should not show</span>
      </DataObject>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('PROVENANCE MISSING');
    expect(screen.queryByText('should not show')).not.toBeInTheDocument();
  });

  it('renders the panel for a server-stripped marker', () => {
    render(
      <DataObject typeName="VesselTrack" value={{ _id: 't9', __provenanceMissing: true }}>
        <span>nope</span>
      </DataObject>,
    );
    expect(screen.getByTestId('provenance-missing')).toBeInTheDocument();
  });
});

describe('assertProvenance', () => {
  it('passes valid nested payloads', () => {
    expect(() =>
      assertProvenance({ items: [{ _id: '1', provenance: validProvenance }] }),
    ).not.toThrow();
  });

  it('throws on a stripped marker', () => {
    expect(() => assertProvenance({ _id: 'x', __provenanceMissing: true })).toThrow(
      ProvenanceError,
    );
  });

  it('throws when an object carries an incomplete provenance', () => {
    expect(() => assertProvenance({ _id: 'y', provenance: { provider: 'x' } })).toThrow(
      ProvenanceError,
    );
  });
});
