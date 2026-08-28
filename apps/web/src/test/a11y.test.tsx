import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axe, { type Result } from 'axe-core';
import type { ReactElement } from 'react';

import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RegisterPage } from '../features/auth/RegisterPage.tsx';
import { InvestigationListPage } from '../features/investigations/InvestigationListPage.tsx';
import { CreateInvestigationPage } from '../features/investigations/CreateInvestigationPage.tsx';
import { CataloguePage } from '../features/catalogue/CataloguePage.tsx';
import { AppChrome } from '../app/AppChrome.tsx';
import { DataObject } from '../components/DataObject.tsx';
import { EvidenceWaterfall } from '../features/candidates/EvidenceWaterfall.tsx';

/**
 * Accessibility gate — 14 §14.6 Phase 13, 05_FRONTEND §5.10, WCAG 2.1 AA.
 *
 * Zero CRITICAL or SERIOUS axe violations on every route that can be rendered in jsdom.
 *
 * WHAT THIS DOES NOT COVER, stated here rather than in a commit message someone has to go
 * find: the workspace route (`/investigations/:id`) mounts MapLibre, which needs a WebGL
 * context jsdom does not provide. Its non-map panels are exercised individually below, but
 * the assembled workspace — the screen an analyst actually spends the session in — is only
 * covered by the manual keyboard and screen-reader passes recorded in CONTEXT.md. Reporting
 * "all routes pass" would be the same species of overclaim this project exists to avoid.
 *
 * Severity floor is deliberate. `minor`/`moderate` findings in jsdom are dominated by
 * colour-contrast rules that cannot evaluate without layout, so gating on them would mean
 * either a permanently red gate or a pile of suppressions. Critical and serious are the
 * levels that actually block a keyboard or screen-reader user.
 */

const BLOCKING: ReadonlyArray<string> = ['critical', 'serious'];

function wrap(ui: ReactElement, route = '/') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={route} element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function describeViolations(violations: Result[]): string {
  return violations
    .map((v) => {
      const where = v.nodes
        .slice(0, 3)
        .map((n) => n.html.slice(0, 120))
        .join('\n        ');
      return `  [${v.impact}] ${v.id}: ${v.help}\n      ${v.helpUrl}\n        ${where}`;
    })
    .join('\n');
}

async function expectNoBlockingViolations(container: HTMLElement) {
  // axe needs the node in the document; RTL already attaches it, but a bare `container`
  // handed in from elsewhere would silently scan nothing and pass.
  expect(container.isConnected).toBe(true);
  expect(container.innerHTML.trim().length).toBeGreaterThan(0);

  const results = await axe.run(container, {
    resultTypes: ['violations'],
    // Contrast and "region" cannot be evaluated meaningfully without real layout, and a
    // fragment rendered outside <main> is a test artefact, not a defect.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });

  const blocking = results.violations.filter((v) => BLOCKING.includes(v.impact ?? ''));
  if (blocking.length > 0) {
    throw new Error(
      `${blocking.length} blocking accessibility violation(s):\n${describeViolations(blocking)}`,
    );
  }
  expect(blocking).toHaveLength(0);
}

beforeEach(() => {
  // Routes fetch on mount. An unmocked fetch makes react-query render an error state, which
  // is a legitimate thing to audit — but a nondeterministic one, so the shape is pinned.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Shapes mirror the real endpoints exactly — `/auth/me` returns the user NESTED under
      // `user`, and AppChrome reads `data.user.email`. A flat mock renders a crash screen,
      // which axe would then scan and pass, auditing an error boundary instead of the page.
      const body = url.includes('/auth/me')
        ? {
            user: {
              id: 'u1',
              email: 'analyst@example.org',
              role: 'analyst',
              name: 'Test Analyst',
            },
            permissions: { role: 'analyst' },
          }
        : url.includes('/investigations')
          ? { items: [], total: 0 }
          : { items: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the a11y harness itself', () => {
  /**
   * A green accessibility suite is indistinguishable from one that scans nothing — a wrong
   * container, a misconfigured rule set, an axe version that quietly changed its API all
   * produce "0 violations". This canary fails the build if the harness stops detecting a
   * violation it certainly should catch.
   */
  it('detects a known serious violation', async () => {
    const { container } = render(
      <div>
        <input type="text" id="unlabelled-on-purpose" />
        <button aria-label="" />
      </div>,
    );
    await expect(expectNoBlockingViolations(container)).rejects.toThrow(
      /blocking accessibility violation/,
    );
  });
});

describe('accessibility — routes renderable in jsdom', () => {
  it('/login has no critical or serious violations', async () => {
    const { container } = render(wrap(<LoginPage />, '/login'));
    await screen.findByRole('button', { name: /sign in/i });
    await expectNoBlockingViolations(container);
  });

  it('/register has no critical or serious violations', async () => {
    const { container } = render(wrap(<RegisterPage />, '/register'));
    await waitFor(() => expect(container.querySelector('form')).toBeTruthy());
    await expectNoBlockingViolations(container);
  });

  it('/investigations has no critical or serious violations', async () => {
    const { container } = render(
      wrap(
        <AppChrome>
          <InvestigationListPage />
        </AppChrome>,
        '/investigations',
      ),
    );
    await waitFor(() => expect(container.textContent).toBeTruthy());
    await expectNoBlockingViolations(container);
  });

  it('/investigations/new has no critical or serious violations', async () => {
    const { container } = render(
      wrap(
        <AppChrome>
          <CreateInvestigationPage />
        </AppChrome>,
        '/investigations/new',
      ),
    );
    await waitFor(() => expect(container.querySelector('form, input')).toBeTruthy());
    await expectNoBlockingViolations(container);
  });

  it('/catalogue has no critical or serious violations', async () => {
    const { container } = render(
      wrap(
        <AppChrome>
          <CataloguePage />
        </AppChrome>,
        '/catalogue',
      ),
    );
    await waitFor(() => expect(container.textContent).toBeTruthy());
    await expectNoBlockingViolations(container);
  });
});

describe('accessibility — workspace panels (the map itself needs WebGL)', () => {
  it('the PROVENANCE MISSING panel is announced, not merely coloured', async () => {
    // This panel exists to stop an analyst trusting an unsourced number. If it is invisible
    // to a screen reader, the guarantee holds for sighted users only.
    const { container } = render(
      <DataObject typeName="SatelliteScene" value={{ _id: 's2' }}>
        <span>18.42 km²</span>
      </DataObject>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('PROVENANCE MISSING');
    await expectNoBlockingViolations(container);
  });

  it('the evidence waterfall has no critical or serious violations', async () => {
    const { container } = render(
      <EvidenceWaterfall
        features={[
          {
            key: 'spatial_proximity',
            status: 'MEASURED',
            rawValue: 3.2,
            rawUnit: 'km',
            normalised: 0.67,
            weight: 0.18,
            contribution: 0.12,
          },
          {
            key: 'heading_alignment',
            status: 'NOT_APPLICABLE',
            rawValue: null,
            rawUnit: '',
            normalised: null,
            weight: 0.12,
            contribution: null,
          },
          {
            key: 'persistent_loitering',
            status: 'MISSING',
            rawValue: null,
            rawUnit: '',
            normalised: null,
            weight: 0.08,
            contribution: null,
          },
        ]}
        measuredCount={1}
        score={67}
        scoreCI={[58, 74]}
      />,
    );
    await expectNoBlockingViolations(container);
  });
});
