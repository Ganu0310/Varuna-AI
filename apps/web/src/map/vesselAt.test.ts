import { describe, it, expect } from 'vitest';
import { vesselAt, vesselsAt, MAX_INTERPOLATION_GAP_SEC } from './vesselAt.ts';

/**
 * Animating a vessel means answering "where was it at 14:32:07" for a moment nobody reported.
 * That answer is a computation, and the ways it can quietly become fabricated evidence are
 * what these tests pin: drawing a vessel outside its observed window, drawing it across a
 * dark period, or presenting an interpolated point as an observed one.
 */

const T = (iso: string) => Date.parse(iso);

/** Two fixes a minute apart, moving due east. */
const SIMPLE = {
  mmsi: 123456789,
  line: {
    type: 'LineString' as const,
    coordinates: [
      [144.6, 13.4],
      [144.7, 13.4],
    ],
  },
  times: [T('2025-09-21T10:00:00Z'), T('2025-09-21T10:01:00Z')],
};

describe('placing a vessel at a moment in time', () => {
  it('returns the exact fix and marks it NOT interpolated', () => {
    const v = vesselAt(SIMPLE, T('2025-09-21T10:00:00Z'));
    expect(v).not.toBeNull();
    expect(v!.lon).toBeCloseTo(144.6, 9);
    expect(v!.interpolated).toBe(false);
  });

  it('interpolates between fixes and SAYS it interpolated', () => {
    const v = vesselAt(SIMPLE, T('2025-09-21T10:00:30Z'));
    expect(v!.lon).toBeCloseTo(144.65, 6);
    // The flag is the point. A computed position that claims to be observed is exactly the
    // confusion the data policy exists to prevent.
    expect(v!.interpolated).toBe(true);
  });

  it('gives a bearing so the marker can be oriented', () => {
    const v = vesselAt(SIMPLE, T('2025-09-21T10:00:30Z'));
    expect(v!.cog).toBeGreaterThan(80);
    expect(v!.cog).toBeLessThan(100); // due east
  });
});

describe('refusing to invent positions', () => {
  it('draws nothing BEFORE the first observation', () => {
    // Carrying a vessel backwards would put it where nothing ever saw it.
    expect(vesselAt(SIMPLE, T('2025-09-21T09:59:59Z'))).toBeNull();
  });

  it('draws nothing AFTER the last observation', () => {
    // The most tempting extrapolation — continue at the last heading — is also the most
    // misleading, because it looks identical to a real track.
    expect(vesselAt(SIMPLE, T('2025-09-21T10:01:01Z'))).toBeNull();
  });

  it('draws nothing ACROSS a dark period', () => {
    const dark = {
      mmsi: 1,
      line: {
        type: 'LineString' as const,
        coordinates: [
          [144.6, 13.4],
          [145.6, 13.4],
        ],
      },
      // Four hours of silence. The vessel could be anywhere in between.
      times: [T('2025-09-21T10:00:00Z'), T('2025-09-21T14:00:00Z')],
    };
    expect(vesselAt(dark, T('2025-09-21T12:00:00Z'))).toBeNull();

    // …but the endpoints are real observations and are still shown.
    expect(vesselAt(dark, T('2025-09-21T10:00:00Z'))).not.toBeNull();
    expect(vesselAt(dark, T('2025-09-21T14:00:00Z'))).not.toBeNull();
  });

  it('interpolates right up to the gap threshold but not past it', () => {
    const mk = (gapSec: number) => ({
      mmsi: 1,
      line: {
        type: 'LineString' as const,
        coordinates: [
          [144.6, 13.4],
          [144.7, 13.4],
        ],
      },
      times: [T('2025-09-21T10:00:00Z'), T('2025-09-21T10:00:00Z') + gapSec * 1000],
    });
    const mid = (gapSec: number) => T('2025-09-21T10:00:00Z') + (gapSec / 2) * 1000;

    expect(
      vesselAt(mk(MAX_INTERPOLATION_GAP_SEC - 1), mid(MAX_INTERPOLATION_GAP_SEC - 1)),
    ).not.toBeNull();
    expect(
      vesselAt(mk(MAX_INTERPOLATION_GAP_SEC + 1), mid(MAX_INTERPOLATION_GAP_SEC + 1)),
    ).toBeNull();
  });
});

describe('malformed input is dropped, not guessed at', () => {
  it('returns null when times and coordinates disagree in length', () => {
    // A mismatch means the pairing is unknown. Zipping what is there would silently attach
    // positions to the wrong times.
    const bad = {
      mmsi: 1,
      line: {
        type: 'LineString' as const,
        coordinates: [
          [144.6, 13.4],
          [144.7, 13.4],
        ],
      },
      times: [T('2025-09-21T10:00:00Z')],
    };
    expect(vesselAt(bad, T('2025-09-21T10:00:00Z'))).toBeNull();
  });

  it('returns null when the server sent no times at all', () => {
    const noTimes = { mmsi: 1, line: SIMPLE.line };
    expect(vesselAt(noTimes, T('2025-09-21T10:00:30Z'))).toBeNull();
  });

  it('returns null for a track with no line', () => {
    expect(vesselAt({ mmsi: 1, line: null, times: [] }, Date.now())).toBeNull();
  });
});

describe('vesselsAt', () => {
  it('omits vessels that cannot be honestly placed rather than dropping the frame', () => {
    const other = {
      mmsi: 2,
      line: {
        type: 'LineString' as const,
        coordinates: [
          [145.0, 13.4],
          [145.1, 13.4],
        ],
      },
      times: [T('2025-09-21T20:00:00Z'), T('2025-09-21T20:01:00Z')],
    };
    const at = T('2025-09-21T10:00:30Z');
    const out = vesselsAt([SIMPLE, other], at);
    expect(out.map((v) => v.mmsi)).toEqual([123456789]);
  });

  it('finds the right segment in a long track', () => {
    // Binary search runs every frame; an off-by-one would place vessels a fix behind.
    const n = 500;
    const start = T('2025-09-21T00:00:00Z');
    const long = {
      mmsi: 9,
      line: {
        type: 'LineString' as const,
        coordinates: Array.from({ length: n }, (_, i) => [144.0 + i * 0.001, 13.0]),
      },
      times: Array.from({ length: n }, (_, i) => start + i * 60_000),
    };
    const v = vesselAt(long, start + 250 * 60_000);
    expect(v!.lon).toBeCloseTo(144.0 + 250 * 0.001, 6);
    expect(v!.interpolated).toBe(false);
  });
});
