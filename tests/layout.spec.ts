/**
 * Layout invariants of the browser half, pinned as assertions.
 *
 * Each case here is a bug that already shipped once, or a rule the shell makes
 * load-bearing. They are asserted against `theme.ts`'s exported style objects
 * rather than against the components, because a client component cannot be
 * imported in Node — the shell's frozen module table does not resolve here
 * (`@deepseek-ai/dsh-client-ui-primitives` wants `clsx`, which this package does
 * not depend on). A style value, by contrast, is plain data, and that is exactly
 * where the failures lived.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as theme from '../src/client/theme'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = join(HERE, '..', 'src', 'client')

describe('the sidebar panel’s scroll region', () => {
  it('carries all three properties that make it the subtree’s scroller', () => {
    // Measured in this installation, `dsh-client-ui-sidebar-right/lib/client.js`:
    //   .P3OORG_tabBody{flex-direction:column;min-width:0;height:100%;
    //                   min-height:0;display:flex;overflow:hidden}
    // The panel is a flex item of that clipper, so without these it is cut off at
    // the fold and nothing in its subtree scrolls — the reported symptom.
    expect(theme.panelFrame.flex).toBe('1 1 auto')
    expect(theme.panelFrame.minHeight).toBe(0)
    expect(theme.panelFrame.overflowY).toBe('auto')
  })

  it('is a column, so the three properties above act on a stacking panel', () => {
    expect(theme.panelFrame.display).toBe('flex')
    expect(theme.panelFrame.flexDirection).toBe('column')
  })

  it('is the frame the panel actually renders', () => {
    // The wiring half of the rule: the properties only help if the component uses
    // them. Read as source text — a component cannot be imported here.
    const source = readFileSync(join(CLIENT_DIR, 'BridgePanel.tsx'), 'utf8')
    expect(source).toContain('panelFrame')
  })
})

describe('the log region', () => {
  it('caps its own height and scrolls inside the panel', () => {
    // The panel scrolls too; the log caps anyway so a chatty build cannot run
    // away with the whole column.
    expect(theme.logBody.maxHeight).toBeDefined()
    expect(theme.logBody.overflow).toBe('auto')
  })
})

describe('the design system’s hairline', () => {
  it('draws every border at 0.5px, never 1px', () => {
    // The shell's own surfaces use half-pixel hairlines (`Button.module.css`,
    // `TerminalBlock.module.css`); a 1px border reads as a different design.
    // Only the shorthand border properties are checked: `borderRadius` is a
    // radius, not a stroke, and matching it would assert nonsense.
    const sides = new Set(['border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight'])
    const values = Object.values(theme).flatMap((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      return Object.entries(value as Record<string, unknown>)
        .filter(([property]) => sides.has(property))
        .map(([, value]) => value)
    })
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(String(value)).toContain('0.5px')
    }
  })
})
