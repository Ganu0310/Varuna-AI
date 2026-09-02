import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROLE_RANK, type Role } from '@varuna/shared';
import {
  useDeleteInvestigation,
  type Investigation,
  type PublicUser,
  type StageCounts,
} from '../../api/hooks.ts';

/**
 * May this account delete this case?
 *
 * The same rule the API enforces (`rbac('analyst')` plus `requireInvestigationAccess('lead')`,
 * with the creator always admitted and admins bypassing), evaluated here only to decide
 * whether to SHOW the control. The server remains the authority; this exists so a viewer or
 * an analyst on someone else's case is not offered a button whose only outcome is a refusal.
 */
export function canDeleteInvestigation(
  inv: Pick<Investigation, 'createdBy' | 'members'> | undefined,
  me: PublicUser | undefined,
): boolean {
  if (!inv || !me) return false;
  if (me.role === 'admin') return true;
  if (ROLE_RANK[me.role] < ROLE_RANK['analyst']) return false;
  if (inv.createdBy && inv.createdBy === me._id) return true;
  const member = (inv.members ?? []).find((m) => String(m.userId) === me._id);
  return member ? ROLE_RANK[member.role as Role] >= ROLE_RANK['lead'] : false;
}

/**
 * Delete an investigation — 06_BACKEND §6.4.2, 04_UIUX §4.11.
 *
 * A case an analyst created by mistake, or one superseded by a better-scoped one, had no way
 * out of the list except an administrator and a database. So this is the analyst's own
 * control, and it is confirmed in two steps rather than one, because the button and the
 * consequence are not the same size.
 *
 * The confirmation states what actually happens, and what actually happens is not a
 * destruction:
 *
 *  - The investigation is FLAGGED deleted. Its document, its scenes, its detections, its
 *    origin estimates, its candidate rankings, its comments and its audit trail all stay
 *    exactly where they are.
 *  - It leaves the investigations list and can no longer be opened by its team.
 *  - An administrator still sees it, with its counts, under Admin → Investigations.
 *
 * That is worth spelling out on the dialog rather than in a doc, for two opposite reasons: an
 * analyst hesitating over a case they think holds irreplaceable evidence should be told it is
 * kept, and an analyst deleting a case because they want the evidence GONE should be told it
 * is not (13_REAL_DATA_POLICY §13.4).
 *
 * The counts come from the caller because both places that mount this already have them —
 * the list card and the workspace rail — and a confirmation dialog that has to fetch before
 * it can tell you what you are about to do is a dialog that tells you nothing at the moment
 * you click.
 */
export function DeleteInvestigation({
  investigationId,
  name,
  counts,
  /** Where to go afterwards. The list stays put; the workspace cannot. */
  redirectTo,
  className,
}: {
  investigationId: string;
  name: string;
  counts?: StageCounts;
  redirectTo?: string;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const del = useDeleteInvestigation();

  const retained = counts
    ? [
        [counts.scenes, 'scene'],
        [counts.detections, 'detection'],
        [counts.origins, 'origin estimate'],
        [counts.candidates, 'candidate vessel'],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, label]) => `${n} ${label}${(n as number) === 1 ? '' : 's'}`)
    : [];

  if (!confirming) {
    return (
      <button
        type="button"
        className={`btn btn-danger ${className ?? ''}`}
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    );
  }

  return (
    <div className="inv-delete" role="alertdialog" aria-label={`Delete ${name}`}>
      <p className="inv-delete-q">
        Delete <strong>{name}</strong>?
      </p>
      <p className="inv-delete-body">
        It leaves your investigations list and your team can no longer open it.{' '}
        {retained.length > 0 ? (
          <>
            Nothing is destroyed: its {retained.join(', ')} and its full audit trail stay in the
            database, and an administrator can still see the case.
          </>
        ) : (
          <>
            Nothing is destroyed: the record and its audit trail stay in the database, and an
            administrator can still see the case.
          </>
        )}
      </p>

      {del.isError ? (
        <p className="inv-delete-error" role="alert">
          {(del.error as Error).message}
        </p>
      ) : null}

      <div className="inv-delete-actions">
        <button
          type="button"
          className="btn btn-danger"
          disabled={del.isPending}
          onClick={() => {
            del.mutate(investigationId, {
              onSuccess: () => {
                setConfirming(false);
                if (redirectTo) navigate(redirectTo);
              },
            });
          }}
        >
          {del.isPending ? 'Deleting…' : 'Delete investigation'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={del.isPending}
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
