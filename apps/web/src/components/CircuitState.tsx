/**
 * A provider's circuit-breaker state, in words an operator can act on.
 *
 * The underlying states are the standard circuit-breaker ones, and they read backwards to
 * anyone who has not met the pattern: `CLOSED` is the HEALTHY state — the circuit is complete
 * so calls flow, exactly like a breaker in a fuse box — while `OPEN` means it has tripped and
 * nothing is getting through. On a status board, the one word an operator most needs to read
 * at a glance was the one that looked like it meant the opposite.
 *
 * So the badge says what is happening and the raw state stays in the tooltip, for anyone
 * reading the API response alongside it.
 *
 * `TRIPPED` rather than `BLOCKED` for the open state because it keeps the breaker metaphor
 * the rest of the system is named for, while being the half of that metaphor that already
 * reads correctly to everyone.
 */

const LABELS: Record<string, { label: string; tone: string; title: string }> = {
  CLOSED: {
    label: 'AVAILABLE',
    tone: 'token-ok',
    title: 'CLOSED — the circuit is complete and calls are flowing normally.',
  },
  OPEN: {
    label: 'TRIPPED',
    tone: 'token-danger',
    title:
      'OPEN — too many consecutive failures, so calls are refused immediately rather than ' +
      'waiting on a provider that is not answering.',
  },
  HALF_OPEN: {
    label: 'TESTING',
    tone: 'token-warn',
    title:
      'HALF_OPEN — the reset window has passed, so the next call is let through to find out ' +
      'whether the provider has recovered.',
  },
};

export function CircuitState({
  state,
  configured = true,
}: {
  state: string;
  configured?: boolean;
}) {
  // A provider with no credential was never called, so it has no meaningful circuit state.
  // Showing AVAILABLE for one would be a green badge on something that cannot serve a request.
  if (!configured) {
    return (
      <span className="token" title="No credential configured; the chain skips this provider.">
        NOT CONFIGURED
      </span>
    );
  }

  const known = LABELS[state];
  if (!known) {
    // An unrecognised state is surfaced verbatim rather than guessed at or hidden.
    return (
      <span className="token token-warn" title={`Unrecognised circuit state: ${state}`}>
        {state}
      </span>
    );
  }

  return (
    <span className={`token ${known.tone}`} title={known.title}>
      {known.label}
    </span>
  );
}
