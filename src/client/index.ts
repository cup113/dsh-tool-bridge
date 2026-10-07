/**
 * The browser half's entry point.
 *
 * Four registrations, and each one is a different kind of UI fact:
 *
 * - the switch row in `conversation.input.dock` — the framework's own "full-width
 *   entries above the composer card" seat, where the harness puts its todo panel
 *   and queue dock. It is reached from the conversation header's cramped action
 *   strip (where it sat beside the agent preset and fought for room on a phone)
 *   to a full row of its own, aligned with the input card;
 * - a sidebar tab type plus its body, so the toolchain's state is one click away
 *   beside the conversation rather than in another window;
 * - the tab chip's own seat (`sidebar.right.pane.tab.title`). A type's `title` is
 *   only the text captured at open time; the chip itself is drawn there, and a
 *   type that registers no entry there gets bare text and no glyph;
 * - a guide entry, so the tab is discoverable by someone who has not read this
 *   file.
 *
 * Everything here is a registration against the shell's frozen module table:
 * React and the `dsh-client-*` packages are the only imports a client bundle can
 * resolve, and a value import outside that table fails at load rather than
 * bundling a second copy of something the shell already owns.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

import { BridgePanel } from './BridgePanel'
import { Switches } from './Switches'
import { TabTitle } from './TabTitle'
import { PANEL_KIND, openPanel } from './openPanel'
import { CLIENT_SERVICES } from './services'

/** The tab type's identity: a package name is the natural value. */
const TAB_ID = '@cup113/dsh-plugin-toolbridge'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /**
     * The conversation whose panel is open.
     *
     * Carried rather than left to the body's own guess: the host can only infer a
     * conversation when exactly one is live, so a panel opened beside a second
     * window would have nothing to show.
     */
    bridge: { readonly sessionId: string }
  }
}

/** Services this half needs; every `ctx.<name>` it touches is listed there. */
export const inject = [...CLIENT_SERVICES]

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: PANEL_KIND,
        // A page type: it is opened by kind, not by a resource address, so it
        // claims no patterns and takes no `canOpen` veto.
        title: () => 'Tool bridge',
        // A list, because a type may offer more than one way in; this one has a
        // single entry box, which is also what makes it discoverable without
        // reading this file (the guide page lists contributed entries by order).
        guide: [
          {
            id: 'toolbridge-panel',
            order: 20,
            title: () => 'Tool bridge',
            description: () =>
              'Lane depth, jobs and logs for the Flutter/Dart and Node toolchains this conversation runs outside the file sandbox.',
            // Without one the guide draws its cube placeholder.
            icon: IconCodeOutlineRegular,
          },
        ],
      }),
    'toolbridge tab type',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, BridgePanel),
      ),
    'toolbridge tab body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TabTitle),
      ),
    'toolbridge tab chip',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'toolbridge',
            // 30 keeps the row directly above the composer card: the dock renders
            // its entries in ascending order, after the diff pill (-100), the todo
            // panel (0) and the queue dock (20).
            order: 30,
            // The dock's owner props carry the input zone, not the conversation;
            // asking for the session id here is how a dock entry learns which
            // conversation it belongs to, and the panel's opener travels the same
            // way (the shell's own job list passes its service calls like this).
            inject: (sessionId: string) => ({
              sessionId,
              openPanel: () => openPanel(ctx.sidebarRight, sessionId),
            }),
          },
          Switches,
        ),
      ),
    'toolbridge switches',
  )
}
