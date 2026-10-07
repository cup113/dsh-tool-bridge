/**
 * The inject set against the code that reads `ctx`.
 *
 * cordis resolves `ctx.<name>` through the fiber's inject set and throws
 * `cannot get property "<name>" without inject` at the moment of access — and
 * because a navigation call is wrapped in a `try/catch`, that throw arrives as a
 * button that does nothing and a warning nobody reads. This is the failure the
 * client half shipped with: `ctx.sidebarRight.openTab(...)` while `inject` held
 * only `slots` and `sidebarRightTabs`.
 *
 * The check reads the sources rather than the bundle: the browser half's
 * components cannot be imported in Node (the shell's frozen module table does not
 * resolve here — `@deepseek-ai/dsh-client-ui-primitives` needs `clsx`, which this
 * package does not depend on), and the bundle text cannot tell a service access
 * from a service name in a list.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CLIENT_SERVICES } from '../src/client/services'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = join(HERE, '..', 'src', 'client')

/**
 * cordis's own members, which need no declaration.
 *
 * `ctx.effect` is the pattern every plugin uses to own a registration, and
 * `ctx.logger`/`ctx.get`/`ctx.inject`/`ctx.reflect` are on the base context.
 * Everything else a plugin reaches for is a service and belongs in `inject`.
 */
const CORDIS_CORE = new Set(['effect', 'get', 'inject', 'logger', 'on', 'plugin', 'provide', 'reflect', 'scope'])

/** Every `ctx.<name>` the browser half reads, across every client source file. */
function serviceAccesses(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const file of readdirSync(CLIENT_DIR)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const source = readFileSync(join(CLIENT_DIR, file), 'utf8')
    for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/gu)) {
      if (match[1] !== undefined) names.add(match[1])
    }
  }
  return names
}

describe('the browser half’s inject set', () => {
  it('scans the client sources for service accesses', () => {
    // Guards the scan itself: a regex that stopped matching would make the next
    // case pass while checking nothing.
    const accessed = serviceAccesses()
    expect(accessed.has('slots')).toBe(true)
    expect(accessed.has('sidebarRight')).toBe(true)
    expect(accessed.has('sidebarRightTabs')).toBe(true)
  })

  it('declares every service the client half reaches for', () => {
    const declared = new Set<string>(CLIENT_SERVICES)
    const undeclared = [...serviceAccesses()]
      .filter((name) => !declared.has(name) && !CORDIS_CORE.has(name))
      .sort()
    expect(undeclared).toEqual([])
  })

  it('lists each service once, and the three this half needs', () => {
    expect([...CLIENT_SERVICES].sort()).toEqual(['sidebarRight', 'sidebarRightTabs', 'slots'])
    expect(new Set(CLIENT_SERVICES).size).toBe(CLIENT_SERVICES.length)
  })
})
