/**
 * The tab chip: what the right sidebar draws on the page's own tab.
 *
 * A tab type's `title` is only the *initial text* captured into the layout
 * record at open time; the chip itself is drawn by the keyed
 * `sidebar.right.pane.tab.title` seat, and a type that registers no such entry
 * gets bare text and no glyph. That seat is why the terminal page can draw its
 * own icon, and why this one can draw this feature's.
 *
 * The label is read from `useTabInfo()` rather than spelled here, so the chip
 * keeps tracking whatever the layout record holds.
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

import { chip } from './theme'

/**
 * Render the chip for the tool-bridge page.
 * @param props - the seat's runtime face, carrying the live tab info hook.
 * @returns the glyph and the tab's current title.
 */
export function TabTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <span style={chip}>
      <IconCodeOutlineRegular />
      <span>{tab.title}</span>
    </span>
  )
}
