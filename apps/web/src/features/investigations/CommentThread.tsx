import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { formatUtc } from '../../lib/format.ts';

/**
 * Analyst notes on a case — 06_BACKEND §6.4.2.
 *
 * The system records what it did; this records what a person thought. Why a detection was
 * dismissed as a rig, why the drift horizon was extended, why the second-ranked vessel was
 * worth another look — none of that is recoverable from the data, and it is exactly what the
 * next analyst on the case needs.
 *
 * Retraction, not editing. A note is evidence of what was believed at a moment, so it can be
 * withdrawn but not quietly rewritten, and the withdrawal stays visible. The UI says so
 * before anyone posts, because a control whose consequences are only discovered afterwards is
 * a trap.
 */

interface Comment {
  _id: string;
  authorEmail: string;
  body: string;
  createdAt: string;
  subjectType: string | null;
  subjectId: string | null;
  retractedAt: string | null;
}

export function CommentThread({
  investigationId,
  subject,
}: {
  investigationId: string;
  /** Anchors the thread to one object, so a note about a detection sits with that detection. */
  subject?: { type: 'DETECTION' | 'CANDIDATE' | 'ORIGIN' | 'SCENE'; id: string };
}) {
  const qc = useQueryClient();
  const me = useMe();
  const [draft, setDraft] = useState('');

  const query = subject ? `?subjectType=${subject.type}&subjectId=${subject.id}` : '';
  const key = ['comments', investigationId, subject?.type ?? null, subject?.id ?? null];

  const comments = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ items: Comment[] }>(`/investigations/${investigationId}/comments${query}`),
  });

  const post = useMutation({
    mutationFn: () =>
      api.post(`/investigations/${investigationId}/comments`, {
        body: draft.trim(),
        ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}),
      }),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const retract = useMutation({
    mutationFn: (id: string) => api.del(`/investigations/${investigationId}/comments/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const items = comments.data?.items ?? [];

  return (
    <section className="comments">
      <h3>Analyst notes</h3>
      <p className="muted">
        What you concluded and why. Notes cannot be edited after posting — they record what was
        believed at the time — but you can retract your own.
      </p>

      {comments.isLoading ? <p className="muted">Loading notes…</p> : null}
      {comments.isError ? <p className="field-error">Could not load notes.</p> : null}

      {!comments.isLoading && items.length === 0 ? (
        <p className="muted">
          No notes yet. The first one is usually the most useful: why this case was opened.
        </p>
      ) : null}

      <ol className="comment-list">
        {items.map((c) => {
          const mine = me.data?.user.email === c.authorEmail;
          return (
            <li key={c._id} className={c.retractedAt ? 'comment comment-retracted' : 'comment'}>
              <div className="comment-head">
                <span className="mono">{c.authorEmail}</span>
                <span className="muted mono">{formatUtc(c.createdAt)}</span>
                {c.subjectType ? (
                  <span className="token">{c.subjectType.toLowerCase()}</span>
                ) : null}
              </div>
              {c.retractedAt ? (
                // The row stays. That a claim was made and withdrawn is itself part of the
                // record, and removing it would leave later notes answering nothing.
                <p className="muted">Retracted {formatUtc(c.retractedAt)}.</p>
              ) : (
                <p className="comment-body">{c.body}</p>
              )}
              {mine && !c.retractedAt ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => retract.mutate(c._id)}
                  disabled={retract.isPending}
                >
                  Retract
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>

      <form
        className="comment-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) post.mutate();
        }}
      >
        <label htmlFor="comment-draft">Add a note</label>
        <textarea
          id="comment-draft"
          value={draft}
          maxLength={4000}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Ranked #2 has a plausible dark period but no draught change — worth a second scene before acting."
        />
        <div className="comment-actions">
          <span className="muted mono">{draft.length}/4000</span>
          <button type="submit" className="btn" disabled={!draft.trim() || post.isPending}>
            {post.isPending ? 'Posting…' : 'Post note'}
          </button>
        </div>
        {post.isError ? (
          <p className="field-error">
            {post.error instanceof ApiError ? post.error.message : 'Could not post the note.'}
          </p>
        ) : null}
      </form>
    </section>
  );
}
