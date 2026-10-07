/**
 * Opening the panel, as a function rather than a closure inside `apply`.
 *
 * The button that calls this lives in the composer dock, where a navigation
 * shortcut is not worth failing a render over — so the throw is caught. Keeping
 * the call in its own module is what lets a test drive that path at all: the
 * components next door cannot be imported outside a browser (the shell's frozen
 * module table is not resolvable in Node), and this is the half that broke.
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
   * Open a page type by kind.
   * @param kind - the registered page kind.
   * @param options - the kind's navigation parameters.
   */
  openTab(kind: string, options?: { readonly params?: { readonly sessionId: string } }): void
}

/**
 * Open this conversation's panel tab, tolerating the cases where it cannot open.
 *
 * The session id travels as a navigation parameter rather than being left for the
 * body to guess: the sidebar's own `state` endpoint can only infer a conversation
 * when exactly one is live, and a panel that goes blank in a second window is a
 * worse panel.
 * @param right - the sidebar's navigation face (`ctx.sidebarRight`).
 * @param sessionId - the conversation whose panel is being opened.
 */
export function openPanel(right: PanelOpener, sessionId: string): void {
  try {
    right.openTab(PANEL_KIND, { params: { sessionId } })
  } catch (error) {
    // A kind nothing registered, or a write with no mounted Session surface: the
    // row's switches keep working either way, so this is reported the way the
    // shell's own client UI reports a rejected navigation.
    console.warn('toolbridge: could not open the panel tab:', error)
  }
}
