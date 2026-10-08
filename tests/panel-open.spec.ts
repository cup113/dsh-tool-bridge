/**
 * Opening the panel from the composer row.
 *
 * Two facts are pinned here, and both were wrong in the same way once: the open
 * must be a plain page open — the conversation it belongs to is resolved by the
 * seat the panel is drawn in, never carried by the open, because the sidebar's
 * own guide opens this type by kind alone — and a rejected open must not escape
 * into the row's click handler (a navigation shortcut is not worth failing a
 * render over).
 */

import { describe, expect, it, vi } from 'vitest'

import { PANEL_KIND, openPanel } from '../src/client/openPanel'

describe('openPanel', () => {
  it('opens the page by kind, naming no conversation', () => {
    const openTab = vi.fn<(kind: string) => void>()

    openPanel({ openTab })

    expect(openTab).toHaveBeenCalledTimes(1)
    // `toHaveBeenCalledWith` is exact: a re-introduced `{ params: … }` second
    // argument fails this case, which is the point of it.
    expect(openTab).toHaveBeenCalledWith(PANEL_KIND)
  })

  it('reports a rejected open instead of throwing at the click handler', () => {
    const openTab = vi.fn(() => {
      throw new Error('sidebarRight: no mounted Session surface')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => openPanel({ openTab })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[1])).toContain('no mounted Session surface')

    warn.mockRestore()
  })
})
