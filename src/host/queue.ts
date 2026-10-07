/**
 * The two-lane queue, keyed by working directory.
 *
 * A serialized queue is the right shape for compiles and test runs and the wrong
 * one for a process that never exits: `vite dev` on the queue lane would starve
 * every build behind it until somebody killed it, so long jobs get their own
 * lane and are serialized among themselves.
 *
 * The key is the **working directory**, not the session. The retired server had
 * one bridge per session, so two conversations on the same project held two
 * independent queues and could run two Flutter builds over one `build/`
 * directory — a corruption the single-process plugin fixes for free. The cost is
 * stated in the plan: a long build in one conversation delays a build in another
 * conversation on the same directory, exactly as it already does within one.
 */

import { LANE_LONG, LANE_QUEUE } from '../engine/surface'
import type { Lane } from '../engine/types'

interface LaneState {
  /** Tail of the lane's chain: the next job awaits this before starting. */
  tail: Promise<unknown>
  /** Unfinished jobs in this lane, the running one included (`aheadOf`). */
  pending: number
}

/** A submitted unit of work and where it sits in line. */
export interface Queued<T> {
  /** Unfinished jobs ahead of this one on its own lane, counting the running one. */
  aheadOf: number
  /** Resolves with the work's own result, after every earlier job on the lane. */
  result: Promise<T>
}

export class Lanes {
  private readonly lanes = new Map<string, LaneState>()

  /**
   * Queue `work` on one lane of one directory and return its place in line.
   *
   * The line is joined synchronously — the caller's `aheadOf` describes the
   * state at submit time, which is the only moment it can be observed — while
   * the work itself starts only after everything ahead of it has settled.
   * @param cwd - the directory whose lane this job joins.
   * @param lane - `queue` for anything that finishes, `long` for anything that runs until killed.
   * @param work - the job body, started once its turn arrives.
   * @returns the caller's position in line and the work's result.
   */
  enqueue<T>(cwd: string, lane: Lane, work: () => Promise<T>): Queued<T> {
    const key = `${lane}\u0000${cwd.toLowerCase()}`
    const state = this.lanes.get(key) ?? { tail: Promise.resolve(), pending: 0 }
    this.lanes.set(key, state)

    const aheadOf = state.pending
    state.pending += 1
    const result = state.tail.then(work)
    // The lane's chain must survive a rejected job — a failed build cannot be
    // allowed to wedge every later job on the lane — while the caller still
    // observes the rejection through `result`.
    state.tail = result.then(
      () => undefined,
      () => undefined,
    )
    void result.catch(() => undefined).finally(() => {
      state.pending -= 1
    })
    return { aheadOf, result }
  }

  /** Unfinished jobs on one lane of one directory: the running one and the waiting ones. */
  depth(cwd: string, lane: Lane = LANE_QUEUE): number {
    return this.lanes.get(`${lane}\u0000${cwd.toLowerCase()}`)?.pending ?? 0
  }

  /** Both lanes of one directory, for the sidebar's view. */
  snapshot(cwd: string): { queue: number; long: number } {
    return { queue: this.depth(cwd, LANE_QUEUE), long: this.depth(cwd, LANE_LONG) }
  }
}
