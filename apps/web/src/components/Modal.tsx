import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A modal dialog, for work that deserves the whole screen.
 *
 * Detection review used to expand INLINE, below the results table, inside a panel that is
 * already sharing width with a map. Two things went wrong with that. The content — four
 * confidence bars, morphology, backscatter, the version history — got a column too narrow to
 * read, so the panel grew a horizontal scrollbar. And clicking "review" pushed everything
 * below it down the page, which moves the row you just clicked out from under the cursor.
 *
 * Rendered through a PORTAL to `document.body` rather than in place. Inside the panel it
 * would inherit that panel's stacking context and `overflow`, so the map and the sticky
 * table header could paint over it and the dialog would be clipped by the scroll container
 * it was trying to escape.
 *
 * The accessibility contract is the part that is easy to skip and expensive to omit:
 *
 *   * focus moves INTO the dialog on open and RETURNS to the trigger on close, so a keyboard
 *     user is not dropped at the top of the document;
 *   * Tab cycles within the dialog — a focusable element behind an overlay you cannot see is
 *     a trap, not a feature;
 *   * Escape closes, and so does a click on the backdrop, but NOT a click that merely ends
 *     there after starting inside (a drag while selecting text must not dismiss the work);
 *   * the page behind is inert to scroll, because a background that moves under a modal makes
 *     the modal feel broken.
 */

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered on the right of the header — actions belonging to the dialog as a whole. */
  headerExtra?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, headerExtra }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // Whether the pointer went DOWN on the backdrop. A click is only a dismissal if it both
  // started and ended there; otherwise selecting text inside and releasing outside closes
  // the dialog and discards what you were reading.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null;

    // Focus the DIALOG, not its first focusable descendant.
    //
    // Focusing a child runs the browser's scroll-into-view, and the first focusable element
    // here sits well down a scrollable body — so the dialog opened already scrolled past its
    // own heading, showing the middle of the review. `preventScroll` covers the case where a
    // child is focused later; focusing the container is what stops it happening on open.
    //
    // It is also the better announcement: a screen reader reads the dialog's label and role
    // rather than dropping the user straight onto a text field with no context.
    panelRef.current?.focus({ preventScroll: true });

    // A dialog must open at its beginning, whatever the browser did while mounting.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus?.();
    };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) return;

      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <div className="modal-head-actions">
            {headerExtra}
            <button className="btn-ghost" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>
        <div className="modal-body" ref={bodyRef}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
