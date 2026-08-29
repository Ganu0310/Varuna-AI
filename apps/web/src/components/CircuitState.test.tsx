import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CircuitState } from './CircuitState.tsx';

/**
 * The point of this component is that the raw states read backwards, so the tests are about
 * what an operator sees rather than what the API returned.
 */
describe('CircuitState', () => {
  it('shows the healthy state as AVAILABLE, not CLOSED', () => {
    render(<CircuitState state="CLOSED" />);
    const badge = screen.getByText('AVAILABLE');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('token-ok');
    // The jargon stays reachable for anyone reading the API response beside the screen.
    expect(badge.title).toContain('CLOSED');
  });

  it('shows a tripped breaker as a danger, not a warning', () => {
    render(<CircuitState state="OPEN" />);
    const badge = screen.getByText('TRIPPED');
    expect(badge.className).toContain('token-danger');
    expect(badge.title).toContain('OPEN');
  });

  it('distinguishes recovery from failure', () => {
    // The admin table used to paint HALF_OPEN with the same styling as OPEN. A provider that
    // is being retried is not a provider that is down, and an operator deciding whether to
    // intervene needs those to look different.
    render(<CircuitState state="HALF_OPEN" />);
    const badge = screen.getByText('TESTING');
    expect(badge.className).toContain('token-warn');
    expect(badge.className).not.toContain('token-danger');
  });

  it('never shows a green badge for a provider with no credential', () => {
    render(<CircuitState state="CLOSED" configured={false} />);
    expect(screen.queryByText('AVAILABLE')).not.toBeInTheDocument();
    const badge = screen.getByText('NOT CONFIGURED');
    expect(badge.className).not.toContain('token-ok');
  });

  it('surfaces an unrecognised state verbatim rather than guessing', () => {
    render(<CircuitState state="MELTED" />);
    expect(screen.getByText('MELTED')).toBeInTheDocument();
  });
});
