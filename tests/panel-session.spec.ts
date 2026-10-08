/**
 * Which conversation the panel is a panel of.
 *
 * The reported defect was not a display bug and not a host bug: the browser half
 * asked the host about *no* conversation (`fetchState(sessionId ?? '')`) whenever
 * the tab's navigation parameters did not carry one — which is every panel opened
 * from the sidebar's own guide, because a guide capsule opens a page type by kind
 * alone. The host answered that question truthfully (`sessionId: null,
 * jobs: []`), and the pane rendered `Jobs (0)` whatever the conversation had run.
 *
 * The component cannot be imported here — the shell's frozen module table does
 * not resolve in Node — so these cases read the sources. They are one-sided on
 * purpose: they pin where the conversation must *not* come from, which is the
 * shape that failed.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = join(HERE, '..', 'src', 'client')

/** One client source, as text. */
function read(file: string): string {
  return readFileSync(join(CLIENT_DIR, file), 'utf8')
}

/**
 * The same source with its comments removed.
 *
 * These files explain the defect they were fixed for, so the very words the
 * cases look for appear in the prose around the code — the scan has to be about
 * what the code does, or it would fail on a correct comment and pass on a
 * comment alone.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

describe('the panel’s conversation', () => {
  const PANEL = code(read('BridgePanel.tsx'))
  const INDEX = code(read('index.ts'))

  it('is not read off the tab the panel is drawn on', () => {
    // `navigation.params` is exactly what a guide-opened page has none of. The
    // case that used to read them is why the sidebar's own entry point showed
    // nothing while the composer's row showed the real jobs.
    expect(PANEL).not.toContain('navigation.params')
    // The read names the seat's session and never defaults it: an empty id is a
    // question the host can only answer with an empty panel, and `?? ''` is how
    // it used to be asked.
    expect(PANEL).toContain('await fetchState(sessionId)')
    expect(PANEL).not.toMatch(/fetchState\([^)]*\?\?/u)
  })

  it('is handed the seat’s own session by the registration', () => {
    // Guard the scan itself: without the anchor the slice below would quietly
    // check the wrong window.
    const anchor = "name: 'sidebar.right.pane.tab'"
    expect(INDEX).toContain(anchor)
    const seat = INDEX.slice(INDEX.indexOf(anchor), INDEX.indexOf(anchor) + 600)
    expect(seat).toMatch(/inject: \(sessionId: string\) => \(\{ sessionId \}\)/)
  })
})
