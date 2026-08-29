import { Link } from 'react-router-dom';

/**
 * Where you are, and how to get back one level.
 *
 * The dossier, prism, relief and globe are full-screen routes with no app chrome, so their
 * only way back was a single bare arrow link — and nothing said which investigation you were
 * looking at once you had left its workspace. With four sibling views of the same
 * investigation, "which one am I in, and which investigation is this" is asked constantly.
 */

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} className={last ? 'crumb-current' : undefined}>
            {c.to && !last ? <Link to={c.to}>{c.label}</Link> : c.label}
            {last ? null : <span aria-hidden="true"> / </span>}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * The four sibling views of one investigation.
 *
 * Offered on each of them, so moving between the dossier, the prism and the relief does not
 * mean returning to the workspace first. The current one is marked rather than removed —
 * dropping it would shift the others and make the set harder to learn.
 */
export function InvestigationViews({
  investigationId,
  current,
}: {
  investigationId: string;
  current: 'workspace' | 'report' | 'prism' | 'relief';
}) {
  const views = [
    { key: 'workspace', label: 'Workspace', to: `/investigations/${investigationId}` },
    { key: 'report', label: 'Dossier', to: `/investigations/${investigationId}/report` },
    { key: 'prism', label: 'Space–time prism', to: `/investigations/${investigationId}/prism` },
    { key: 'relief', label: 'Slick relief', to: `/investigations/${investigationId}/relief` },
  ] as const;

  return (
    <nav className="view-switch" aria-label="Views of this investigation">
      {views.map((v) => (
        <Link
          key={v.key}
          to={v.to}
          className={v.key === current ? 'view-switch-on' : undefined}
          aria-current={v.key === current ? 'page' : undefined}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}
