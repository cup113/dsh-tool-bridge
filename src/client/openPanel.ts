/**
 * Opening the panel, as a function rather than a closure inside `apply`.
 *
 * The button that calls this lives in the composer dock, where a navigation
 * shortcut is not worth failing a render over — so the throw is caught. Keeping
 * the call in its own module is what lets a test drive that path at all: the
 * components next door cannot be imported outside a browser (the shell's frozen
 * module table is not resolvable in Node), and this is the half that broke.
 *
 * The open names a page kind and nothing else. It used to carry the conversation
 * as a navigation parameter, which is how the panel knew which session to show
 * when it was opened from this row — and is exactly why the same panel opened
 * from the sidebar's own guide (which opens a type by kind alone) showed an
 * empty job list: the parameter was absent, and the panel had no other source
 * for its conversation. The conversation now comes from the seat, which is
 * session-scoped and therefore knows it (ADR-0012).
 */

/** The page kind the tab type registers and `openTab` names. */
export const PANEL_KIND = 'bridge'

/**
 * The opener face: the one method this module uses, so a test needs no controller.
 *
 * Structurally a subset of `ctx.sidebarRight`; the shell's `openTab` also takes
 * placement options, which a page opener has no opinion about.
 */
export interface PanelOpener {
  /**
   * Open a page kind, in the pane holding the tab the caller is in.
   * @param kind - the registered page kind.
   */
  openTab(kind: string): void
}

/**
 * Open the panel tab beside the conversation the caller is in.
 *
 * The tab lands in the on-screen session's own surface, and the body reads that
 * session from its seat; nothing about the conversation travels through this
 * call.
 * @param right - the sidebar's navigation face (`ctx.sidebarRight`).
 */
export function openPanel(right: PanelOpener): void {
  try {
    right.openTab(PANEL_KIND)
  } catch (error) {
    // A kind nothing registered, or a write with no mounted Session surface: the
    // row's switches keep working either way, so this is reported the way the
    // shell's own client UI reports a rejected navigation.
    console.warn('toolbridge: could not open the panel tab:', error)
  }
}
