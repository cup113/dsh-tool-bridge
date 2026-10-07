#!/usr/bin/env node
/**
 * Build both halves of the plugin.
 *
 * The esbuild NATIVE CLI with inherited stdio is used on purpose rather than
 * the JS API: the API derives the compiler as a child process over pipes, and
 * the DSH file sandbox denies the named pipes libuv needs for that
 * (`spawn EPERM`). A build that only runs outside the session it serves is the
 * wrong build.
 *
 * The browser half is not plain ESM: the web shell's module loader takes a CJS
 * closure factory, so the bundle is wrapped in the `__ModuleLoader__.load`
 * envelope the shipped client bundles use. Everything bare stays external,
 * which is exactly the frozen module table (`react`, `react/jsx-runtime`,
 * `@deepseek-ai/cordis`, the `dsh-client-*` packages) — an import outside that
 * table fails loudly at load instead of silently bundling a second copy.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Resolve the platform's esbuild executable, not the `.cmd` shim. */
function esbuildBinary() {
  const key = `@esbuild/${process.platform}-${process.arch}`
  const relative = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
  try {
    return require.resolve(`${key}/${relative}`)
  } catch {
    return join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  }
}

function run(args) {
  const result = spawnSync(esbuildBinary(), args, { stdio: 'inherit', cwd: root })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

mkdirSync(join(root, 'lib'), { recursive: true })
const common = ['--bundle', '--packages=external', '--log-level=warning']

run([
  'src/host/index.ts',
  ...common,
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--sourcemap',
  '--outfile=lib/index.js',
])

const clientTmp = join(root, 'lib', '.client.bundle.js')
run([
  'src/client/index.ts',
  ...common,
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--outfile=lib/.client.bundle.js',
])

const body = readFileSync(clientTmp, 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/u, '')
const envelope = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${body}\n\t\treturn module.exports;\n\t},\n});\n`
rmSync(clientTmp, { force: true })

/**
 * The browser half's registration surface, asserted BEFORE the artifact is
 * written.
 *
 * Which seat the switches occupy is a decision, not an implementation detail: it
 * was moved out of the conversation header because that strip is cramped on a
 * phone. Asserting on the in-memory envelope rather than on the file matters —
 * a failed check must leave the previous artifact in place, not a tainted one
 * that a watcher would happily serve (`file:///…/scripts/build.mjs` learned this
 * the hard way during the guard's own drill).
 *
 * The check reads the *bundle text*, so it can only see strings that survive
 * bundling: registration names, labels, titles. That is exactly the class the
 * decision lives in — a comment saying otherwise would prove nothing.
 */
const expected = ['conversation.input.dock', 'sidebar.right.pane.tab']
const forbidden = ['conversation.session.header.actions']
for (const needle of expected) {
  if (!envelope.includes(needle)) {
    throw new Error(`client bundle does not register ${needle}: the switches would be unreachable`)
  }
}
for (const needle of forbidden) {
  if (envelope.includes(needle)) {
    throw new Error(`client bundle still registers ${needle}: the header strip is not where the switches belong`)
  }
}

writeFileSync(join(root, 'lib', 'client.js'), envelope)
console.log(`client bundle registers ${expected.join(', ')}`)


