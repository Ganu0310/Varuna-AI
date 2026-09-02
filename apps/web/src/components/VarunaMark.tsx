/**
 * The VARUNA mark.
 *
 * This is the project's actual logo artwork, served from `public/brand/`. It replaced a
 * hand-built SVG recreation: that version was close, but a logo is an identity rather than an
 * illustration, and an approximation of one is simply the wrong mark.
 *
 * The source is 474x521 — TALLER than it is wide — so it is never forced into a square. The
 * `size` prop sets the HEIGHT and the width follows from the natural ratio; constraining both
 * would either squash the shield or crop the antenna and signal arcs off the top right.
 *
 * A decorative instance (no title) is hidden from the accessibility tree. Beside the wordmark
 * in the rail it carries nothing a screen reader needs, and an `<img>` with empty alt text is
 * announced as "image" followed by nothing — which axe flags as a serious violation, rightly.
 */

/** The artwork's own aspect ratio, hard-coded so layout is stable before the image loads. */
const ASPECT = 474 / 521;

export function VarunaMark({ size = 96, title = 'VARUNA' }: { size?: number; title?: string }) {
  const decorative = title.trim() === '';
  return (
    <img
      className="varuna-mark"
      src="/brand/varuna-logo.jpeg"
      width={Math.round(size * ASPECT)}
      height={size}
      alt={decorative ? '' : title}
      {...(decorative ? { 'aria-hidden': true } : {})}
      // The mark is in the rail on every authenticated screen, so it is worth fetching early;
      // it is small, and a logo that pops in after the page makes a build feel unfinished.
      loading="eager"
      decoding="async"
      draggable={false}
    />
  );
}
