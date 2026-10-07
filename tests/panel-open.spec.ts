/**
 * Opening the panel from the composer row.
 *
 * Two facts are pinned here, and both were wrong in the same way once: the open
 * must name the conversation it belongs to (the host can only infer one when
 * exactly one session is live), and a rejected open must not escape into the
 * row's click handler (a navigation shortcut is not worth failing a render
 * over).
 */

import { describe, expect, it, vi } from 'vitest'

import { PANEL_KIND, openPanel } from '../src/client/openPanel'

describe('openPanel', () => {
  it('opens the page by kind, carrying the conversation as a navigation parameter', () => {
    const openTab = vi.fn<(kind: string, options?: { params?: { sessionId: string } }) => void>()

    openPanel({ openTab }, 'session-a')

    expect(openTab).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith(PANEL_KIND, { params: { sessionId: 'session-a' } })
  })

  it('reports a rejected open instead of throwing at the click handler', () => {
    const openTab = vi.fn(() => {
      throw new Error('sidebarRight: no mounted Session surface')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => openPanel({ openTab }, 'session-a')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[1])).toContain('no mounted Session surface')

    warn.mockRestore()
  })
})
