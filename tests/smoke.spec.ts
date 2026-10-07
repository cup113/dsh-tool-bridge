import { describe, expect, it } from 'vitest'
import { RefusalError, refuse } from '../src/engine/errors'
import type { TestFailure } from '../src/engine/types'

describe('engine scaffolding', () => {
  it('carries a refusal code and keeps the message model-facing', () => {
    const refusal = (() => {
      try {
        refuse(403, "command not allowed: 'rm'")
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(refusal).toBeInstanceOf(RefusalError)
    expect((refusal as RefusalError).code).toBe(403)
    expect((refusal as RefusalError).message).toBe("command not allowed: 'rm'")
  })

  it('keeps the reported-failure shape flat', () => {
    const failure: TestFailure = { file: null, name: 'loads', didNotComplete: true }
    expect(Object.keys(failure).sort()).toEqual(['didNotComplete', 'file', 'name'])
  })
})
