/**
 * The line-level ARB editor: insert, replace and delete localization keys in a
 * project's `app_*.arb` files without reformatting anything else in them.
 *
 * Ported from the retired server's `scripts/arb_edit_lib.py`, behaviour intact.
 * Three properties are the contract here, and each is the reason a piece of the
 * work sits in this module rather than in a caller:
 *
 * - Line endings belong to the file. Its bytes are split on the ending that file
 *   actually uses and rejoined with the same one, so editing the LF English ARB
 *   never rewrites the CRLF Chinese one next to it.
 * - Values go out as raw UTF-8, never `\uXXXX`-escaped: a CJK translation stays
 *   legible in the diff, which is the only review such an edit ever gets.
 * - The plan phase computes *every* file's new content before *any* file is
 *   written, so a missing anchor fails the whole plan with zero files touched
 *   instead of leaving a half-edited set behind.
 *
 * Errors are split the way the HTTP route split them: a schema problem is a 400
 * refusal (nothing was queued), while a semantic problem — an anchor missing
 * from one file of the set, a `l10n.yaml` that is not there — is a plain `Error`
 * raised during planning, so the caller reports a failed job with nothing
 * written. The status page reads the doctor's note, not a stack trace.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RefusalError, refuse } from './errors'
import type {
  ArbGroup,
  ArbInstruction,
  ArbNewField,
  ArbPlan,
  ArbUntranslated,
  FilePlan,
  SkippedFile,
} from './types'

/** The only top-level fields an instruction body may carry. */
const ALLOWED_TOP_FIELDS: ReadonlySet<string> = new Set(['groups', 'dryRun'])

/**
 * A top-level ARB key line like `  "someKey": "value",` — the key name is group
 * 1. Also matches `  "@someKey": {` metadata openers.
 */
const KEY_PATTERN = /^\s*"([^"]+)"\s*:/

/** Decodes a file's bytes strictly: invalid UTF-8 is a failed plan, not mojibake. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/* ------------------------------------------------------- line-level helpers */

/** Return CRLF if the file uses it, otherwise LF. */
export function detectLineEnding(raw: Uint8Array): '\r\n' | '\n' {
  for (let index = 0; index + 1 < raw.length; index += 1) {
    if (raw[index] === 0x0d && raw[index + 1] === 0x0a) return '\r\n'
  }
  return '\n'
}

/** The 0-based index of the line that defines `key`, else undefined. */
export function findKeyLine(lines: readonly string[], key: string): number | undefined {
  for (const [index, line] of lines.entries()) {
    const match = KEY_PATTERN.exec(line)
    if (match !== null && match[1] === key) return index
  }
  return undefined
}

/** The line index of the closing `}` of the top-level JSON object. */
export function findClosingBrace(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const stripped = (lines[index] ?? '').trim()
    if (stripped === '}') return index
    if (stripped !== '') break
  }
  return undefined
}

/** Escape a string for embedding in JSON (non-ASCII stays readable). */
function jsonStringEscape(text: string): string {
  return JSON.stringify(text)
}

/** The leading whitespace of `line`. */
function lineIndent(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? ''
}

/** `str.rstrip()`, for the characters a single line can carry. */
function rstrip(text: string): string {
  return text.replace(/\s+$/, '')
}

/** Python's `str.splitlines()`: every line boundary the ARB and YAML readers honour. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
}

/** Python's `repr()` of a string, which the `key not found` messages spell. */
function pyRepr(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `'${escaped}'`
}

/** Python's `is None`, for a field the wire may carry as JSON null. */
function isNone(value: unknown): boolean {
  return value === undefined || value === null
}

/** Whether `value` is a JSON object (never an array, never null). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Python's falsiness for a JSON value, which `{}` and `[]` both satisfy. */
function pyFalsy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true
  if (value === 0 || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * The Python `group.get('newFields') or []` fallback, after validation.
 *
 * An empty JSON object reads as "no fields" there rather than as a type error —
 * which is why `newFields: {}` meant a pure delete to the original and why the
 * falsy check lives in `validateGroup` — and every other non-list is refused
 * before a plan is built.
 */
function newFieldsOrEmpty(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : []
}

/** Whether `path` is a directory (a missing path is not). */
function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** Whether the next non-blank line after `index` is the closing `}`. */
function nextNonBlankIsBrace(lines: readonly string[], index: number): boolean {
  for (const line of lines.slice(index + 1)) {
    const stripped = line.trim()
    if (stripped === '') continue
    return stripped === '}'
  }
  return false
}

/**
 * The line where brace depth, starting at `start`, returns to 0.
 *
 * String literals are skipped so braces inside values (a description like
 * `See: {a:{b}}`) do not skew the count.
 */
function braceCloseIndex(lines: readonly string[], start: number): number | undefined {
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < lines.length; index += 1) {
    for (const char of lines[index] ?? '') {
      if (inString) {
        if (escape) escape = false
        else if (char === '\\') escape = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
    if (depth === 0) return index
  }
  return undefined
}

/**
 * If the line after `end` opens an `@key` block, extend `end` to the block's
 * closing line, so metadata stays attached to its key.
 */
function extendToIncludeMetadata(lines: readonly string[], end: number): number {
  let index = end + 1
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1
  if (index >= lines.length) return end
  const match = KEY_PATTERN.exec(lines[index] ?? '')
  if (match !== null && (match[1] ?? '').startsWith('@')) {
    const closing = braceCloseIndex(lines, index)
    if (closing !== undefined) return closing
  }
  return end
}

/**
 * Drop the trailing comma of the last entry before `}`, in place.
 *
 * Needed after a deletion removes the tail block: the formerly second-to-last
 * entry (which carried a comma) becomes the last and would break the JSON.
 */
function stripTrailingCommaIfLast(lines: string[]): void {
  const braceIndex = findClosingBrace(lines)
  if (braceIndex === undefined) return
  for (let index = braceIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const stripped = rstrip(line)
    if (stripped.endsWith(',')) lines[index] = stripped.slice(0, -1)
    return
  }
}

/* ----------------------------------------------------------- line surgery */

/** The new line list and the key names a delete removed, for the change report. */
export interface DeleteRangeResult {
  lines: string[]
  removedKeys: string[]
}

/**
 * Delete the lines of `deleteFrom` .. `deleteTo` (inclusive).
 *
 * An `@key` metadata block immediately following `deleteTo` is deleted with it,
 * so placeholder metadata cannot be orphaned. Raises `Error` (a failed plan).
 */
export function deleteRange(
  lines: readonly string[],
  deleteFrom: string,
  deleteTo: string,
): DeleteRangeResult {
  const start = findKeyLine(lines, deleteFrom)
  const end = findKeyLine(lines, deleteTo)
  if (start === undefined) throw new Error(`deleteFrom key not found: ${pyRepr(deleteFrom)}`)
  if (end === undefined) throw new Error(`deleteTo key not found: ${pyRepr(deleteTo)}`)
  if (start > end) {
    throw new Error(
      `deleteFrom (${pyRepr(deleteFrom)} at line ${start + 1}) comes after ` +
        `deleteTo (${pyRepr(deleteTo)} at line ${end + 1})`,
    )
  }
  const last = extendToIncludeMetadata(lines, end)
  // Report the keys the caller actually named — top-level entries only. A
  // deleted `@key` block carries nested keys of its own, and listing those
  // would read as if the caller had asked to delete them separately.
  const indent = lineIndent(lines[start] ?? '')
  const removedKeys: string[] = []
  for (const line of lines.slice(start, last + 1)) {
    if (lineIndent(line) !== indent) continue
    const match = KEY_PATTERN.exec(line)
    if (match !== null && match[1] !== undefined) removedKeys.push(match[1])
  }
  const result = [...lines.slice(0, start), ...lines.slice(last + 1)]
  stripTrailingCommaIfLast(result)
  return { lines: result, removedKeys }
}

/**
 * Insert `(key, value)` entries after `anchorKey` (or before the closing brace
 * for `__END__`).
 *
 * Trailing commas are kept valid in every position: the entry before the
 * insertion point gains one, each new entry keeps one except the last when it
 * ends up immediately before `}`. When the anchor carries an `@key` metadata
 * block, the entries land *after* the block so it stays attached. Raises
 * `Error` (a failed plan).
 */
export function insertAfterKey(
  lines: readonly string[],
  anchorKey: string,
  newEntries: readonly (readonly [string, string])[],
): string[] {
  const working = [...lines]
  let insertIndex: number
  let atEnd: boolean
  let indent: string
  let tailBeforeBrace: boolean

  if (anchorKey === '__END__') {
    const closing = findClosingBrace(working)
    if (closing === undefined) throw new Error('could not find the closing brace of the ARB file')
    insertIndex = closing
    atEnd = true
    indent = '  '
    // The former last entry is now followed by new entries, so it needs a
    // trailing comma (a metadata block's `},` already has one).
    let prevIndex = insertIndex - 1
    while (prevIndex >= 0 && (working[prevIndex] ?? '').trim() === '') prevIndex -= 1
    if (prevIndex >= 0) {
      const previous = working[prevIndex] ?? ''
      indent = lineIndent(previous)
      if (previous.trim() !== '{' && !rstrip(previous).endsWith(',')) {
        working[prevIndex] = `${rstrip(previous)},`
      }
    }
    tailBeforeBrace = true
  } else {
    const anchorIndex = findKeyLine(working, anchorKey)
    if (anchorIndex === undefined) {
      throw new Error(`insertAfter key not found: ${pyRepr(anchorKey)}`)
    }
    indent = lineIndent(working[anchorIndex] ?? '')
    insertIndex = extendToIncludeMetadata(working, anchorIndex)
    const entry = rstrip(working[insertIndex] ?? '')
    if (!entry.endsWith(',')) working[insertIndex] = `${entry},`
    atEnd = false
    tailBeforeBrace = nextNonBlankIsBrace(working, insertIndex)
  }

  const newLines: string[] = []
  for (const [position, entry] of newEntries.entries()) {
    const isLastNew = position === newEntries.length - 1
    const omitComma = isLastNew && tailBeforeBrace
    const [key, value] = entry
    let line = `${indent}"${key}": ${jsonStringEscape(value)}`
    if (!omitComma) line += ','
    newLines.push(line)
  }

  if (atEnd) {
    return [...working.slice(0, insertIndex), ...newLines, ...working.slice(insertIndex)]
  }
  return [
    ...working.slice(0, insertIndex + 1),
    ...newLines,
    ...working.slice(insertIndex + 1),
  ]
}

/* --------------------------------------------------- instruction validation */

/** One key to insert, with its value map collapsed to a single ARB file's text. */
export interface AdaptedField {
  key: string
  value: string
}

/** An instruction group adapted to one ARB file. */
export interface AdaptedGroup {
  insertAfter?: string
  deleteFrom?: string
  deleteTo?: string
  newFields: AdaptedField[]
}

/**
 * Check the instruction schema and return the normalized instruction.
 *
 * This is the route's 400 layer: everything checkable without touching the
 * filesystem is checked here, so a typo never costs a queued job. Refuses with
 * a message that names the offending field.
 */
export function validateInstructions(body: unknown): ArbInstruction {
  const record = asRecord(body)
  if (record === undefined) refuse(400, 'instruction body must be a JSON object')
  if ('cwd' in record) {
    refuse(
      400,
      "'cwd' is not accepted: the bridge pins the working directory at " +
        'boot (start a bridge with --cwd <project> to edit that project)',
    )
  }
  const unknownFields = Object.keys(record)
    .filter((field) => !ALLOWED_TOP_FIELDS.has(field))
    .sort()
  if (unknownFields.length > 0) {
    refuse(
      400,
      `unknown field(s): ${unknownFields.join(', ')} ` +
        `(allowed: ${[...ALLOWED_TOP_FIELDS].sort().join(', ')})`,
    )
  }
  const dryRun: unknown = 'dryRun' in record ? record.dryRun : false
  if (typeof dryRun !== 'boolean') refuse(400, "'dryRun' must be a boolean")
  const groupsValue: unknown = record.groups
  if (!Array.isArray(groupsValue) || groupsValue.length === 0) {
    refuse(400, "'groups' must be a non-empty list")
  }
  const groups: readonly unknown[] = groupsValue
  for (const [groupIndex, group] of groups.entries()) validateGroup(groupIndex, group)

  const named = new Set<string>()
  let hasPureDelete = false
  for (const group of groups) {
    const groupRecord = asRecord(group)
    if (groupRecord === undefined) continue
    const fields = newFieldsOrEmpty(groupRecord.newFields)
    if (fields.length === 0) hasPureDelete = true
    for (const field of fields) {
      const value = asRecord(asRecord(field)?.value)
      if (value === undefined) continue
      for (const arbName of Object.keys(value)) named.add(arbName)
    }
  }
  if (named.size === 0 && !hasPureDelete) refuse(400, 'no ARB files referenced in newFields')
  return { groups: groups as ArbGroup[], dryRun }
}

/** Schema checks for one group. Refuses with a message naming the field. */
function validateGroup(groupIndex: number, group: unknown): void {
  const where = `groups[${groupIndex}]`
  const record = asRecord(group)
  if (record === undefined) refuse(400, `${where} must be an object`)
  const rawFields: unknown = record.newFields
  const fieldsValue: unknown = pyFalsy(rawFields) ? [] : rawFields
  if (!Array.isArray(fieldsValue)) refuse(400, `${where}.newFields must be a list`)
  const fields: readonly unknown[] = fieldsValue

  const deleteFrom: unknown = record.deleteFrom
  const deleteTo: unknown = record.deleteTo
  if (isNone(deleteFrom) !== isNone(deleteTo)) {
    refuse(400, `${where}: deleteFrom and deleteTo must be provided together`)
  }
  for (const name of [deleteFrom, deleteTo]) {
    if (!isNone(name) && (typeof name !== 'string' || name === '')) {
      refuse(400, `${where}: deleteFrom/deleteTo must be non-empty strings`)
    }
  }
  const insertAfter: unknown = record.insertAfter
  if (!isNone(insertAfter) && (typeof insertAfter !== 'string' || insertAfter === '')) {
    refuse(400, `${where}: insertAfter must be a non-empty string`)
  }
  if (fields.length > 0 && isNone(insertAfter)) {
    refuse(
      400,
      `${where}: insertAfter is required when newFields is given ` +
        '(use the key before the insertion point, or __END__)',
    )
  }
  if (fields.length === 0 && isNone(deleteFrom)) {
    // Neither an insert nor a delete: a group like that does no work, and
    // treating it as a pure delete would silently rewrite every app_*.arb
    // file and run gen-l10n for nothing (the old script did exactly that).
    refuse(400, `${where}: a group needs newFields or a deleteFrom/deleteTo range`)
  }
  for (const [fieldIndex, field] of fields.entries()) {
    validateField(`${where}.newFields[${fieldIndex}]`, field)
  }
}

/** Schema checks for one newFields entry. Refuses with a message naming the field. */
function validateField(where: string, field: unknown): void {
  const record = asRecord(field)
  if (record === undefined) refuse(400, `${where} must be an object`)
  const key: unknown = record.key
  if (typeof key !== 'string' || key === '') refuse(400, `${where}.key must be a non-empty string`)
  if (key.startsWith('@')) {
    refuse(
      400,
      `${where}.key must not start with '@': gen-l10n writes @key ` +
        'metadata itself, and a hand-written string value is not a Map',
    )
  }
  const value = asRecord(record.value)
  if (value === undefined || Object.keys(value).length === 0) {
    refuse(
      400,
      `${where}.value must be a non-empty map of ` +
        'ARB file name -> translation string',
    )
  }
  for (const [arbName, text] of Object.entries(value)) {
    if (arbName === '') refuse(400, `${where}.value keys must be ARB file names`)
    if (typeof text !== 'string') {
      refuse(400, `${where}.value[${pyRepr(arbName)}] must be a string`)
    }
  }
}

/* ------------------------------------------------------------- l10n.yaml */

/**
 * The project's `l10n.yaml` as key-value pairs.
 *
 * Kept as the hand-written mini-parser the original was: the accepted shape
 * (`key: value`, `#` comments, no nesting, no quoting) is part of the
 * behaviour, and a general YAML reader would accept files this one refuses.
 * Raises `Error` (a failed plan) when the file is not there.
 */
export function parseL10nYaml(cwd: string): Record<string, string> {
  const l10nPath = join(cwd, 'l10n.yaml')
  if (!existsSync(l10nPath)) throw new Error(`l10n.yaml not found at ${l10nPath}`)
  const config: Record<string, string> = {}
  for (const line of splitLines(readFileSync(l10nPath, 'utf8'))) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator >= 0) {
      config[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
    }
  }
  return config
}

/* --------------------------------------------------------- plan and apply */

/**
 * Adapt instruction groups to one ARB file.
 *
 * A group's delete part applies to every file being edited (the old skill's
 * documented semantics), while only the fields whose value map names this file
 * are inserted. Groups left with neither are dropped.
 */
export function fileGroupsFor(groups: readonly ArbGroup[], arbName: string): AdaptedGroup[] {
  const adapted: AdaptedGroup[] = []
  for (const group of groups) {
    const fields: AdaptedField[] = []
    const declared = newFieldsOrEmpty(group.newFields) as readonly ArbNewField[]
    for (const field of declared) {
      const text = field.value[arbName]
      if (text === undefined) continue
      fields.push({ key: field.key, value: text })
    }
    const hasDelete = !isNone(group.deleteFrom) && !isNone(group.deleteTo)
    if (fields.length === 0 && !hasDelete) continue
    adapted.push({ ...group, newFields: fields })
  }
  return adapted
}

/** One file's new bytes plus the key names that changed, for the report. */
export interface AppliedFileGroups {
  newBytes: Uint8Array
  inserts: string[]
  deletes: string[]
}

/**
 * Apply adapted groups to one file's bytes; pure, no filesystem.
 *
 * Returns the new bytes and the inserted/deleted key names for the change
 * report. Raises `Error` on a missing anchor or a bad delete range.
 */
export function applyFileGroups(
  raw: Uint8Array,
  fileGroups: readonly AdaptedGroup[],
): AppliedFileGroups {
  const eol = detectLineEnding(raw)
  let lines = UTF8_DECODER.decode(raw).split(eol)
  const inserts: string[] = []
  const deletes: string[] = []
  for (const group of fileGroups) {
    const deleteFrom = group.deleteFrom
    const deleteTo = group.deleteTo
    if (deleteFrom && deleteTo) {
      const removal = deleteRange(lines, deleteFrom, deleteTo)
      lines = removal.lines
      deletes.push(...removal.removedKeys)
    }
    const fields = group.newFields
    if (fields.length > 0) {
      const anchor = group.insertAfter
      if (anchor === undefined) {
        throw new Error('insertAfter is required when newFields is given')
      }
      const entries = fields.map((field) => [field.key, field.value] as const)
      lines = insertAfterKey(lines, anchor, entries)
      inserts.push(...fields.map((field) => field.key))
    }
  }
  return { newBytes: new TextEncoder().encode(lines.join(eol)), inserts, deletes }
}

/** The `app_*.arb` file names in `arbDir`, the target set of a pure delete. */
function appArbNames(arbDir: string): string[] {
  return readdirSync(arbDir).filter((name) => /^app_.*\.arb$/.test(name))
}

/**
 * Compute every file's new content before writing anything.
 *
 * A semantic error (an anchor missing from one file of the set, a delete range
 * in the wrong order) throws here, so a failed plan leaves every file
 * byte-identical — the property the old script lacked.
 */
export function planArbEdits(cwd: string, instruction: ArbInstruction): ArbPlan {
  const normalized = validateInstructions(instruction)
  const config = parseL10nYaml(cwd)
  const arbDir = join(cwd, config['arb-dir'] ?? 'lib/l10n')
  if (!isDirectory(arbDir)) throw new Error(`ARB directory not found: ${arbDir}`)
  const groups = normalized.groups

  let named = new Set<string>()
  for (const group of groups) {
    const fields = newFieldsOrEmpty(group.newFields)
    if (fields.length === 0) continue
    for (const field of fields) {
      const value = asRecord(asRecord(field)?.value)
      if (value === undefined) continue
      for (const arbName of Object.keys(value)) named.add(arbName)
    }
  }
  if (named.size === 0) {
    // A pure-delete instruction (no newFields anywhere) targets every
    // app_*.arb file in the arb-dir, as the old skill did.
    named = new Set(appArbNames(arbDir))
  }

  const files: FilePlan[] = []
  const skipped: SkippedFile[] = []
  for (const arbName of [...named].sort()) {
    const arbPath = join(arbDir, arbName)
    if (!existsSync(arbPath)) {
      skipped.push({ file: arbName, reason: 'not found' })
      continue
    }
    const raw = readFileSync(arbPath)
    let applied: AppliedFileGroups
    try {
      applied = applyFileGroups(raw, fileGroupsFor(groups, arbName))
    } catch (error) {
      if (error instanceof RefusalError) throw error
      // Name the file: the same instruction can be valid for one ARB file and
      // invalid for another, and "key not found" alone does not say which one
      // to look at.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${arbName}: ${message}`, { cause: error })
    }
    files.push({
      name: arbName,
      path: arbPath,
      newBytes: applied.newBytes,
      inserts: applied.inserts,
      deletes: applied.deletes,
    })
  }
  const untranslated = config['untranslated-messages-file']
  return {
    files,
    skipped,
    untranslatedFile: untranslated ? join(cwd, untranslated) : null,
  }
}

/** Write the planned files. Returns the edited file names. */
export function applyArbEdits(plan: ArbPlan): string[] {
  const edited: string[] = []
  for (const entry of plan.files) {
    writeFileSync(entry.path, entry.newBytes)
    edited.push(entry.name)
  }
  return edited
}

/**
 * The untranslated-messages-file, when it exists with real content.
 *
 * gen-l10n sometimes leaves an empty `{}` placeholder behind; that counts as
 * "no untranslated messages", as does a missing file.
 */
export function readUntranslated(path: string | null): ArbUntranslated | null {
  if (path === null || !existsSync(path)) return null
  const content = readFileSync(path, 'utf8').trim()
  if (content === '' || content === '{}' || content === '[]') return null
  return { file: basename(path), lines: splitLines(content).length, content }
}
