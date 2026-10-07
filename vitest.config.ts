import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // The DSH file sandbox denies the named pipes libuv needs for a forked
    // child's stdio, so the `forks` pool dies with `spawn EPERM` there while
    // `threads` (worker_threads, no named pipes) runs confined and unconfined
    // alike. The suite must be runnable in the environment it describes.
    pool: 'threads',
  },
})
