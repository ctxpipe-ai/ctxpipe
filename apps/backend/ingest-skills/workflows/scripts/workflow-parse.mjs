// Read the structure of a GitHub Actions workflow file with no YAML parser:
// the sandbox has none. The reader knows the block YAML that workflows use
// (maps, lists, quoted and plain scalars, one-line flow lists). It never
// reads the text of a block scalar (`run: |`), an anchor, an alias, a tag,
// or a flow map, and it gives no value for them. A file that it cannot
// follow with certainty (a tab as indent, a duplicate key, a quote or a flow
// list that does not close on its line, a complex key, more than one
// document) gives null. The caller then skips the file.
//
// The workflow file is hostile. The reader builds no regular expression
// from its text, and it caps the line count, the line length, and the
// depth.

const MAX_ROWS = 20_000
const MAX_LINE = 4000
const MAX_DEPTH = 64

const OPAQUE = Object.freeze({ t: "opaque" })

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
    rows.push({
      indent,
      tab: rest.startsWith("\t"),
      text: rest.replace(/[ \t]+$/, ""),
    })
  }
  if (rows[0]?.indent === 0 && /^---(?:[ \t]+#.*)?$/.test(rows[0].text))
    rows.shift()
  return rows
}

/** The text before a comment, outside quotes. */
function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === '"') {
      if (c === "\\") i++
      else if (c === '"') quote = null
    } else if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") i++
      else if (c === "'") quote = null
    } else if (
      (c === '"' || c === "'") &&
      (i === 0 || /[\s[,]/.test(text[i - 1]))
    )
      quote = c
    else if (c === "#" && (text[i - 1] === " " || text[i - 1] === "\t"))
      return text.slice(0, i)
  }
  return text
}

const isSeqItem = (text) => text === "-" || text.startsWith("- ")

/**
 * `{ key, value }` of a `key: value` line, or null. A key is plain or quoted
 * on one line; `value` is the raw text after the colon.
 */
function keyValue(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]
    let i = 1
    let key = ""
    for (; i < text.length; i++) {
      if (quote === "'" && text[i] === "'" && text[i + 1] === "'") {
        key += "'"
        i++
      } else if (text[i] === quote) break
      else if (quote === '"' && text[i] === "\\") return null
      else key += text[i]
    }
    if (i >= text.length) return null
    const rest = text.slice(i + 1).replace(/^[ \t]+/, "")
    if (!rest.startsWith(":")) return null
    const after = rest.slice(1)
    if (after !== "" && !/^[ \t]/.test(after)) return null
    return { key, value: after }
  }
  if (/^[?:,[\]{}#&*!|>'"%@`]/.test(text) || isSeqItem(text)) return null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "#" && /[ \t]/.test(text[i - 1] ?? "")) return null
    if (c !== ":") continue
    const next = text[i + 1]
    if (next !== undefined && next !== " " && next !== "\t") continue
    const key = text.slice(0, i).replace(/[ \t]+$/, "")
    return key ? { key, value: text.slice(i + 1) } : null
  }
  return null
}

/** A one-line flow list of scalars, or undefined when the reader cannot read it. */
function flowList(value) {
  const items = []
  let i = 1
  const space = () => {
    while (value[i] === " " || value[i] === "\t") i++
  }
  space()
  if (value[i] === "]") i++
  else
    for (;;) {
      space()
      let item
      const c = value[i]
      if (c === '"' || c === "'") {
        let j = i + 1
        item = ""
        for (; j < value.length; j++) {
          if (c === "'" && value[j] === "'" && value[j + 1] === "'") {
            item += "'"
            j++
          } else if (value[j] === c) break
          else if (c === '"' && value[j] === "\\") return undefined
          else item += value[j]
        }
        if (j >= value.length) return undefined
        i = j + 1
      } else {
        let j = i
        while (j < value.length && value[j] !== "," && value[j] !== "]") {
          if ("[]{}\"'".includes(value[j])) return undefined
          j++
        }
        item = value.slice(i, j).trim()
        if (!item) return undefined
        i = j
      }
      items.push(item)
      space()
      if (value[i] === ",") {
        i++
        space()
        if (value[i] === "]") {
          i++
          break
        }
        continue
      }
      if (value[i] === "]") {
        i++
        break
      }
      return undefined
    }
  return value.slice(i).trim() === "" ? { t: "list", a: items } : undefined
}

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
 * The tree of a workflow file: `{ t: "map", m }`, `{ t: "seq", a }`,
 * `{ t: "str", v }`, `{ t: "list", a }` (a flow list of scalars),
 * `{ t: "opaque" }` (a value that the reader does not read), or null (an
 * empty value). Null for the whole file when it cannot follow the file.
 */
export function readYamlTree(text) {
  let rows
  try {
    rows = rowsOf(text)
  } catch {
    return null
  }
  let pos = 0
  let depth = 0

  const skipDeeper = (indent) => {
    while (pos < rows.length && rows[pos].indent > indent) pos++
  }
  const noDeeper = (indent) => {
    if (pos < rows.length && rows[pos].indent > indent) fail()
  }

  const node = (indent) => {
    if (++depth > MAX_DEPTH) fail()
    const row = rows[pos]
    if (row.tab) fail()
    const out = isSeqItem(row.text) ? seq(indent) : map(indent)
    depth--
    return out
  }

  /** The value after `key:` or `- ` on a row at `indent`; the row is read. */
  const value = (raw, indent) => {
    const text = stripComment(raw).trim()
    if (text === "") {
      const next = rows[pos]
      if (next && next.indent > indent) return node(next.indent)
      if (next && next.indent === indent && isSeqItem(next.text))
        return seq(indent)
      return null
    }
    const c = text[0]
    if ("|>&!*".includes(c)) {
      // A block scalar, an anchor, a tag, or an alias: never read.
      skipDeeper(indent)
      return OPAQUE
    }
    if (c === "[") {
      const list = flowList(text)
      if (list === undefined) {
        if (!closesOnLine(text)) fail()
        noDeeper(indent)
        return OPAQUE
      }
      noDeeper(indent)
      return list
    }
    if (c === "{") {
      if (!closesOnLine(text)) fail()
      noDeeper(indent)
      return OPAQUE
    }
    if (c === '"') {
      const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text)
      if (!match) fail()
      noDeeper(indent)
      return match[1].includes("\\") ? OPAQUE : { t: "str", v: match[1] }
    }
    if (c === "'") {
      const match = /^'((?:[^']|'')*)'$/.exec(text)
      if (!match) fail()
      noDeeper(indent)
      return { t: "str", v: match[1].replaceAll("''", "'") }
    }
    if ("%@`]}".includes(c) || /^[-?:](?:[ \t]|$)/.test(text)) fail()
    if (pos < rows.length && rows[pos].indent > indent) {
      // A plain scalar on more than one line.
      skipDeeper(indent)
      return OPAQUE
    }
    if (keyValue(text)) fail()
    return { t: "str", v: text }
  }

  const map = (indent) => {
    const m = new Map()
    while (pos < rows.length) {
      const row = rows[pos]
      if (row.indent < indent) break
      if (row.indent > indent || row.tab) fail()
      if (isSeqItem(row.text)) break
      if (row.indent === 0 && /^(?:---|\.\.\.|%)/.test(row.text)) fail()
      const entry = keyValue(row.text)
      // A merge key (`<<: *defaults`) has an alias value, which the
      // reader does not read; the keys that it adds are not read either.
      if (!entry || m.has(entry.key)) fail()
      pos++
      m.set(entry.key, value(entry.value, indent))
    }
    return { t: "map", m }
  }

  const seq = (indent) => {
    const a = []
    while (pos < rows.length) {
      const row = rows[pos]
      if (row.indent < indent) break
      if (row.indent > indent || row.tab) fail()
      if (!isSeqItem(row.text)) break
      const after = row.text.slice(1)
      const inner = after.replace(/^ +/, "")
      if (inner === "" || inner.startsWith("#")) {
        pos++
        const next = rows[pos]
        a.push(next && next.indent > indent ? node(next.indent) : null)
        continue
      }
      if (inner.startsWith("\t")) fail()
      if (isSeqItem(inner) || keyValue(inner)) {
        // A compact map or list: read it as rows at the column of its text.
        rows[pos] = {
          indent: indent + 1 + (after.length - inner.length),
          tab: false,
          text: inner,
        }
        a.push(node(rows[pos].indent))
        continue
      }
      pos++
      a.push(value(inner, indent))
    }
    return { t: "seq", a }
  }

  try {
    if (rows.length === 0 || rows[0].indent !== 0) return null
    const tree = node(0)
    return pos === rows.length ? tree : null
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

const mapOf = (n) => (n?.t === "map" ? n.m : null)
const strOf = (n) => (n?.t === "str" ? n.v : null)
const strings = (n) =>
  n?.t === "list"
    ? n.a
    : n?.t === "seq"
      ? n.a.map(strOf).filter((v) => v !== null)
      : n?.t === "str"
        ? [n.v]
        : []

/**
 * The parts of a workflow that a knowledge file holds, or { skip: reason }:
 * `name` (null when the file has none), the trigger names (`triggers`), the
 * job ids (`jobs`), and `locations`: each `on.<event>.paths` filter and each
 * `working-directory` (top level, job, or step) as `{ where, value }`. It
 * never reads a `run`, `env`, `with`, or `secrets` value.
 */
export function readWorkflow(text) {
  const tree = readYamlTree(text)
  const top = mapOf(tree)
  if (!top) return { skip: "The file is not YAML that the script can read" }
  const jobs = mapOf(top.get("jobs"))
  if (!jobs || jobs.size === 0) return { skip: "The file has no jobs" }

  const on = top.get("on")
  const events = mapOf(on)
  const triggers = events ? [...events.keys()] : strings(on)
  const locations = []
  for (const [event, filter] of events ?? []) {
    for (const value of strings(mapOf(filter)?.get("paths")))
      locations.push({ where: `on.${event}.paths`, value })
  }
  const workingDirectory = (defaults) =>
    strOf(mapOf(mapOf(defaults)?.get("run"))?.get("working-directory"))
  const shared = workingDirectory(top.get("defaults"))
  if (shared !== null)
    locations.push({ where: "defaults.run.working-directory", value: shared })
  for (const [id, raw] of jobs) {
    const job = mapOf(raw)
    const own = workingDirectory(job?.get("defaults"))
    if (own !== null)
      locations.push({
        where: `jobs.${id}.defaults.run.working-directory`,
        value: own,
      })
    const steps = job?.get("steps")
    for (const step of steps?.t === "seq" ? steps.a : []) {
      const value = strOf(mapOf(step)?.get("working-directory"))
      if (value !== null)
        locations.push({
          where: `jobs.${id}.steps.working-directory`,
          value,
        })
    }
  }
  return {
    name: strOf(top.get("name")),
    triggers,
    jobs: [...jobs.keys()],
    locations,
  }
}
