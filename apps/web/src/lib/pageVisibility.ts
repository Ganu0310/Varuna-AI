import { useEffect, useState } from 'react';

/**
 * Whether the tab is currently hidden — 04_UIUX §4.6.4.
 *
 * The rule the design system states is that a 3D surface freezes to a static frame when the
 * page is not visible. Browsers already throttle `requestAnimationFrame` in a background tab,
 * so this is not primarily about wasted frames; it is about two things that throttling makes
 * WORSE rather than better:
 *
 *  - **A clock that jumps.** A paused rAF means the next callback arrives with a delta of
 *    however long the tab was hidden. Any loop integrating that delta advances by minutes in
 *    one frame, so an analyst who switches away mid-playback comes back to a playhead
 *    somewhere they did not put it. `useTimeStore` is the record of where the analyst is in
 *    the incident, and it must not move while nobody is looking at it.
 *
 *  - **Contexts held awake.** WebGL work scheduled outside rAF — deck.gl's own redraws, a
 *    MapLibre transition — is not throttled with it, so a hidden workspace can sit spinning
 *    two GL contexts on a laptop running on battery.
 *
 * `visibilitychange` rather than `blur`: clicking another window does not hide the tab, and
 * an analyst comparing the map against a document beside it should not have the map stop.
 */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  );

  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    // Read once on mount as well: the tab can already be hidden when a component mounts —
    // a route rendered into a background tab, or a restored session.
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return hidden;
}
