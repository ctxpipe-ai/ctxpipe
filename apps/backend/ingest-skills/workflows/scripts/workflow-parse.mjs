// Read the parts of a GitHub Actions workflow file that a knowledge file
// holds, with no YAML parser: the sandbox has none. The reader walks the
// lines of the block YAML that workflows use and reads only 7 key paths:
// `name`, `on`, `on.<event>.paths`, the ids under `jobs`, and
// `working-directory` at the top level and in a job (`defaults.run`), and in
// a step. It reads no other value.
//
// After a key or a list item with a value on its line, the reader skips
// each deeper line. Thus it never reads the text of a block scalar
// (`run: |`), of a value on more lines, or of a value with an anchor or a
// tag. It gives no value for a block scalar, an anchor, an alias, a tag, or
// a flow map. A file that it cannot follow with certainty (a tab or other
// white space as indent, a duplicate key, a quote or a flow value that does
// not close on its line, a complex key, more than one document) gives a
// skip.
//
// The workflow file is hostile. The reader builds no regular expression
// from its text, and it caps the line count, the line length, and the
// depth.

import { yamlEntry } from "../../apis/scripts/apis-lib.mjs"

const MAX_ROWS = 20_000
const MAX_LINE = 4000
const MAX_DEPTH = 64

const OPAQUE = Object.freeze({ opaque: true })
/** The path part of a list item. */
const ITEM = Symbol("list item")
const UNREADABLE = { skip: "The file is not YAML that the script can read" }

class Unreadable extends Error {}

const fail = () => {
  throw new Unreadable()
}

/** The lines that hold structure: not blank and not a comment. */
function rowsOf(text) {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  if (/[\r\u0085\u2028\u2029]/.test(clean)) fail()
  const lines = clean.split("\n")
  if (lines.length > MAX_ROWS) fail()
  const rows = []
  for (const line of lines) {
    if (line.length > MAX_LINE) fail()
    const indent = /^ */.exec(line)[0].length
    const rest = line.slice(indent)
    if (/^[ \t]*$/.test(rest) || rest.startsWith("#")) continue
    // A tab or other white space after the indent: the reader fails only
    // when it reads the row, because a block scalar can hold such a line.
    rows.push({ indent, space: /^\s/.test(rest), text: rest.trimEnd() })
  }
  if (rows[0]?.indent === 0 && /^---(?:[ \t]+#.*)?$/.test(rows[0].text))
    rows.shift()
  return rows
}

const isSeqItem = (text) => text === "-" || text.startsWith("- ")

/** True when a flow value that starts on this line also ends on it. */
function closesOnLine(value) {
  let depth = 0
  let quote = null
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote === '"') {
      if (c === "\\") i++
      else if (c === '"') quote = null
    } else if (quote === "'") {
      if (c === "'" && value[i + 1] === "'") i++
      else if (c === "'") quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") {
      depth--
      if (depth === 0) return value.slice(i + 1).trim() === ""
    }
  }
  return false
}

/**
 * The scalars of a one-line flow list that closes on its line, or null when
 * an item is not a plain or simple quoted scalar.
 */
function flowList(value) {
  const items = []
  const end = value.length - 1
  let i = 1
  while (i < end) {
    while (value[i] === " " || value[i] === "\t") i++
    const quote = value[i]
    let j
    let item
    if (quote === '"' || quote === "'") {
      j = value.indexOf(quote, i + 1)
      if (j === -1 || j >= end) return null
      item = value.slice(i + 1, j)
      // An escape or a doubled quote: the reader does not read the item.
      if (item.includes("\\") || value[j + 1] === quote) return null
      j++
    } else {
      j = i
      while (j < end && value[j] !== ",") j++
      item = value.slice(i, j).trim()
      if (/[[\]{}"']/.test(item)) return null
    }
    while (value[j] === " " || value[j] === "\t") j++
    if (j < end && value[j] !== ",") return null
    if (item === "") {
      // `[]`, `[ ]`, or a comma after the last item.
      if (j >= end) break
      return null
    }
    items.push(item)
    i = j + 1
  }
  return items
}

/**
 * A scalar value: the text of a plain or quoted scalar, OPAQUE for a value
 * that the reader does not read, or a list of scalars for a one-line flow
 * list. Fails when a quote or a flow value does not close on the line.
 */
function scalar(value) {
  const c = value[0]
  if (c === undefined || "|>&!*".includes(c)) return OPAQUE
  if (c === '"') {
    const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value)
    if (!match) fail()
    return match[1].includes("\\") ? OPAQUE : match[1]
  }
  if (c === "'") {
    const match = /^'((?:[^']|'')*)'$/.exec(value)
    if (!match) fail()
    return match[1].replaceAll("''", "'")
  }
  if (c === "[" || c === "{") {
    if (!closesOnLine(value)) fail()
    return (c === "[" && flowList(value)) || OPAQUE
  }
  return value
}

/** The text before a ` #` comment of a list item. */
const uncomment = (text) => {
  const at = text.search(/\s#/)
  return (at === -1 ? text : text.slice(0, at)).trim()
}

/**
 * Walk the rows. `visit(path, value)` gets each key and each scalar list
 * item: `path` holds the keys from the top, with ITEM for a list item;
 * `value` is undefined for a key whose value is on the next rows.
 */
function walk(rows, visit) {
  const stack = [{ indent: -1, path: [], keys: new Set() }]
  let skipDeeper = Infinity
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.indent > skipDeeper) continue
    skipDeeper = Infinity
    if (row.space) fail()
    let column = row.indent
    let text = row.text
    for (;;) {
      const top = stack.at(-1)
      if (top.indent < column) break
      // A list can be at the column of its key.
      if (top.indent === column && top.open && isSeqItem(text)) break
      stack.pop()
    }
    // The value on the row. A deeper row after it continues the value, so
    // the reader gives no value; a quote or a flow value that does not close
    // on the row fails first.
    const valueOf = (text) => {
      const value = scalar(text)
      return rows[i + 1]?.indent > column ? OPAQUE : value
    }
    for (;;) {
      const parent = stack.at(-1)
      if (stack.length > MAX_DEPTH) fail()
      const item = isSeqItem(text)
      // The top is a map at column 0. The children of a node have one
      // column and one form.
      if (parent.indent === -1 && (column !== 0 || item)) fail()
      parent.child ??= { column, item }
      if (parent.child.column !== column || parent.child.item !== item) fail()
      if (item) {
        const inner = text.slice(1).replace(/^ +/, "")
        if (/^\s/.test(inner)) fail()
        const path = [...parent.path, ITEM]
        if (inner === "" || inner.startsWith("#")) {
          stack.push({ indent: column, path, keys: new Set() })
          break
        }
        if (isSeqItem(inner) || yamlEntry(inner)) {
          // A compact map or list: read its text at its own column.
          stack.push({ indent: column, path, keys: new Set() })
          column += text.length - inner.length
          text = inner
          continue
        }
        skipDeeper = column
        visit(path, valueOf(uncomment(inner)))
        break
      }
      const entry = yamlEntry(text)
      if (!entry || entry.indent !== 0 || parent.keys.has(entry.key)) fail()
      parent.keys.add(entry.key)
      const path = [...parent.path, entry.key]
      if (entry.value === "") {
        stack.push({ indent: column, path, keys: new Set(), open: true })
        visit(path, undefined)
      } else {
        skipDeeper = column
        visit(path, valueOf(entry.value))
      }
      break
    }
  }
}

/** `path` is `parts`; a null part matches each key, but not a list item. */
const at = (path, ...parts) =>
  path.length === parts.length &&
  parts.every((part, i) =>
    part === null ? typeof path[i] === "string" : part === path[i],
  )

const strings = (value) =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value : []

/**
 * The parts of a workflow that a knowledge file holds, or { skip: reason }:
 * `name` (null when the file has none), the trigger names (`triggers`), the
 * job ids (`jobs`), and `locations`: each `on.<event>.paths` filter and each
 * `working-directory` (top level, job, or step) as `{ where, value }`. It
 * never reads a `run`, `env`, `with`, or `secrets` value.
 */
export function readWorkflow(text) {
  let name = null
  const triggers = []
  const jobs = []
  const locations = []
  const place = (where, values) => values.map((value) => ({ where, value }))
  const one = (value) => (typeof value === "string" ? [value] : [])
  try {
    walk(rowsOf(text), (path, value) => {
      const event = path[1]
      if (at(path, "name") && typeof value === "string") name = value
      else if (at(path, "on") || at(path, "on", ITEM))
        triggers.push(...strings(value))
      else if (at(path, "on", null)) triggers.push(event)
      else if (
        at(path, "on", null, "paths") ||
        at(path, "on", null, "paths", ITEM)
      )
        locations.push(...place(`on.${event}.paths`, strings(value)))
      else if (at(path, "jobs", null)) jobs.push(path[1])
      else if (at(path, "defaults", "run", "working-directory"))
        locations.push(...place("defaults.run.working-directory", one(value)))
      else if (at(path, "jobs", null, "defaults", "run", "working-directory"))
        locations.push(
          ...place(
            `jobs.${path[1]}.defaults.run.working-directory`,
            one(value),
          ),
        )
      else if (at(path, "jobs", null, "steps", ITEM, "working-directory"))
        locations.push(
          ...place(`jobs.${path[1]}.steps.working-directory`, one(value)),
        )
    })
  } catch (error) {
    if (error instanceof Unreadable) return UNREADABLE
    throw error
  }
  if (jobs.length === 0) return { skip: "The file has no jobs" }
  return { name, triggers, jobs, locations }
}
