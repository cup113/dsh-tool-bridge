/**
 * The browser half's visual vocabulary: one place where the shell's design
 * tokens become names.
 *
 * The switch row, the tab chip and the sidebar panel are three surfaces of one
 * feature, so they must not each invent their own borders, greys and code face.
 * Every value here is a token the running theme actually defines (verified
 * against the theme's own stylesheet, not assumed from a sibling component's
 * CSS): `--ds-font-family-code`, the `--dsw-alias-*` label/surface/border layer,
 * and the `--dsw-radius-*` steps. The one trap this module exists to close is
 * `--dsw-alias-label-error`, which reads plausibly and is **defined nowhere** —
 * the state colour is `--dsw-alias-state-error-primary`.
 *
 * Type-only import, so the module stays loadable outside a browser.
 */

import type { CSSProperties } from 'react'

/** The design system's code face, with a fallback for the moment before the theme lands. */
export const MONO = "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)"

/** Borders in this design system are 0.5px hairlines, never 1px. */
export const HAIRLINE = '0.5px solid var(--dsw-alias-border-l2)'

/** An inset card: the panel's blocks, and the terminal surface's frame. */
export const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: HAIRLINE,
  borderRadius: 'var(--dsw-radius-md)',
}

/** Inline contents of a chip: icon and label, never wider than the chip. */
export const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary)',
}

/**
 * The sidebar panel's own frame, and the scroll region it has to be.
 *
 * Since the 0.2.0 release candidate the right sidebar wraps **every** tab body in
 * a fixed-height clipper — measured in this installation, inside
 * `dsh-client-ui-sidebar-right/lib/client.js`:
 *
 * ```css
 * .P3OORG_tabBody{flex-direction:column;min-width:0;height:100%;min-height:0;
 *                 display:flex;overflow:hidden}
 * ```
 *
 * A body is then a flex item of a box already exactly as tall as the pane, so its
 * content is cut at the fold and **nothing in the subtree scrolls**: the clipper
 * is `hidden`, not scrollable, and an ancestor's `overflow:auto` never gains
 * anything to scroll because this element was clipped first. The three
 * properties below are what make the panel itself that scroll region —
 * `minHeight: 0` is the load-bearing one, because a flex item's automatic minimum
 * size is its content, so without it the panel refuses to shrink and
 * `overflowY: 'auto'` never engages.
 *
 * (Under 0.1.5-rc.2 the pane body was the scroller and these were inert, which is
 * why a plugin written against that shell scrolls nothing here.)
 */
export const panelFrame: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '10px 12px',
  fontFamily: MONO,
  fontSize: '12px',
  lineHeight: '18px',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
}

/** Monospace body text, at the size the terminal-flavoured surfaces use. */
export const mono: CSSProperties = {
  fontFamily: MONO,
  fontSize: '12px',
  lineHeight: '18px',
}

/** One uppercase group heading. */
export const sectionTitle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontFamily: MONO,
  fontSize: '11px',
  lineHeight: '16px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}

/** Secondary label text: a caption, or a value that is context rather than content. */
export const muted: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }

/** A failure the reader has to notice. */
export const danger: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

/** A compact status capsule: mono, on the raised surface, never wrapped. */
export const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '1px 6px',
  background: 'var(--dsw-alias-bg-layer-2)',
  borderRadius: 'var(--dsw-radius-sm)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: MONO,
  fontSize: '11px',
  lineHeight: '16px',
  whiteSpace: 'nowrap',
}

/** The status dot that leads a job row; its colour carries the state. */
export const dot = (color: string): CSSProperties => ({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  background: color,
  flex: 'none',
})

/** One job in the list: a row, not a bordered box, with hairlines between rows. */
export const jobRow = (selected: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  width: '100%',
  padding: '5px 6px',
  border: 'none',
  borderRadius: 'var(--dsw-radius-sm)',
  background: selected ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
})

/** The scrolling half of the log card: the only thing here that scrolls. */
export const logBody: CSSProperties = {
  background: 'var(--dsw-alias-bg-base)',
  maxHeight: '320px',
  overflow: 'auto',
  padding: '8px 10px',
  fontFamily: MONO,
  fontSize: '11px',
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
