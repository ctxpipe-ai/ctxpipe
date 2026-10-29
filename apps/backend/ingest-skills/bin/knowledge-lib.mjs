// Shared code of the script-only skills (libraries, ownership). They run with
// no model. Each one finds facts with scripts, writes the staged tree in
// <root>/out/files, and writes patch.json. The host patch validator
// (apps/backend/src/domain/ingestion/patch-validator.ts) checks the result.
//
// A script never sets a host field (generated_by, sources, source_sha, skill,
// bundle, confidence). It changes an existing file only additively: new
// claims, and new list lines in a `## Related` section at the end. The
// validator accepts that for each file, also for a file that a human or
// another source owns.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { posix } from "node:path"

import { MAX_ROOTS, safePath } from "../discover-roots/scripts/roots-lib.mjs"
import {
  baseBlob,
  blobContent,
  currentStep,
  ensureParent,
  fail,
  parseArgs,
  stagedFile,
  writePatch,
} from "./stage-lib.mjs"

/** The validator refuses more ops in one step. */
const MAX_STEP_OPS = 30
const MAX_RELATED_LINES = 200

/**
 * The one argument parser of the skill scripts (ADR-052 section 6): the host
 * inputs --source <checkout>, --source-url <url>, --source-path <path> (the
 * source file of the repository in the Workspace, the value of `sources`),
 * --roots <file>, and --path <root> in a root step only. --root <dir>
 * moves the step folder (default /ctxpipe). `value(name)` reads a further
 * option of the script.
 * A script that needs no step folder uses this; `scriptStep` adds the step.
 */
export function stepArgs(argv = process.argv.slice(2)) {
  const { root, args } = parseArgs(argv)
  const value = (name) => {
    const at = args.indexOf(name)
    return at === -1
      ? null
      : (args[at + 1] ?? fail(`Give a value after ${name}`))
  }
  const source = value("--source") ?? fail("Give --source <checkout>")
  const sourceUrl = value("--source-url") ?? fail("Give --source-url <url>")
  const sourcePath =
    value("--source-path") ?? fail("Give --source-path <source file path>")
  if (!SOURCE_PATH.test(sourcePath))
    fail(`${sourcePath} is not a source file path`)
  const rootsFile = value("--roots") ?? fail("Give --roots <roots file>")
  if (!existsSync(rootsFile)) fail(`${rootsFile} does not exist`)
  // A root step names its root; a repository-wide step has none.
  const rootPath = value("--path")
  if (
    rootPath !== null &&
    (!safePath(rootPath) ||
      rootPath.startsWith("/") ||
      (rootPath !== "." && posix.normalize(rootPath) !== rootPath) ||
      rootPath
        .split("/")
        .some((s) => s === "" || (s === "." && rootPath !== ".")))
  )
    fail(`${rootPath} is not a safe root path`)
  const repository = repositoryName(sourceUrl)
  if (!repository) fail(`${sourceUrl} is not a repository URL`)
  return {
    root,
    args,
    source,
    sourceUrl,
    sourcePath,
    rootsFile,
    rootPath,
    repository,
    value,
  }
}

/** A source file path of ADR-050: sources/<provider>/[<group>/]<name>.md. */
const SOURCE_PATH =
  /^sources\/[a-z]+\/(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\.md$/

/**
 * Arguments (ADR-052 section 6, the same for each skill): --source
 * <checkout> --source-url <url> --source-path <path> --roots <file>, and
 * --path <root> in a root step only. --root <dir> moves the step folder
 * (default /ctxpipe).
 *
 * The roots file is the host's root-to-file map (ADR-052 section 6):
 *   { "roots": [{ "path", "manifests", "evidence", "files": ["knowledge/..."] }] }
 * `files` are the context files that the root steps of the root wrote. Only
 * a file that exists at the base commit and whose `sources` hold the source
 * path counts. Each root in the result has `files: [{ path, kind }]`.
 */
export function scriptStep(argv = process.argv.slice(2)) {
  const {
    root,
    source,
    sourceUrl,
    sourcePath,
    rootsFile,
    rootPath,
    repository,
    value,
  } = stepArgs(argv)
  const step = currentStep(root)
  const listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
  if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
  const skipped = []
  const roots = []
  if (listed.length > MAX_ROOTS)
    skipped.push({
      path: null,
      reason: `The script read only the first ${MAX_ROOTS} roots of the roots file`,
    })
  for (const entry of listed.slice(0, MAX_ROOTS)) {
    if (!safePath(entry?.path)) {
      skipped.push({
        path: null,
        reason: "A root path has characters that the script does not quote",
      })
      continue
    }
    const files = []
    for (const path of Array.isArray(entry.files) ? entry.files : []) {
      const file = sourceFile(step, path, sourcePath)
      if (file) files.push(file)
      else
        skipped.push({
          path: safePath(path) ? path : null,
          reason: `The file of root ${entry.path} is not a context file of this source`,
        })
    }
    roots.push({
      path: entry.path,
      manifests: Array.isArray(entry.manifests)
        ? entry.manifests.filter((m) => typeof m === "string" && safePath(m))
        : [],
      files,
    })
  }
  return {
    step,
    source,
    sourceUrl,
    sourcePath,
    repository,
    roots,
    rootPath,
    index: readIndex(step),
    skipped,
    value,
  }
}

/**
 * { path, kind } of a context file at the base commit whose sources hold
 * `sourcePath`, or null.
 */
function sourceFile(step, path, sourcePath) {
  if (
    !safePath(path) ||
    !path.startsWith("knowledge/") ||
    !path.endsWith(".md")
  )
    return null
  const text = baseText(step, path)
  const yaml = text && frontMatter(text)
  if (!yaml || !frontList(yaml, "sources").includes(sourcePath)) return null
  return { path, kind: frontValue(yaml, "kind") }
}

function frontMatter(text) {
  return (
    /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? null
  )
}

const unquote = (text) => text.trim().replace(/^(["'])(.*)\1$/, "$2")

/** A top-level scalar of a front matter block, or null. */
function frontValue(yaml, key) {
  const line = yaml.split("\n").find((l) => l.startsWith(`${key}:`))
  return line ? unquote(line.slice(key.length + 1)) || null : null
}

/** A top-level list of a front matter block, in block or flow form. */
function frontList(yaml, key) {
  const lines = yaml.split("\n")
  const at = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (at === -1) return []
  const rest = lines[at].slice(key.length + 1).trim()
  if (rest.startsWith("["))
    return rest.slice(1, rest.lastIndexOf("]")).split(",").map(unquote)
  const items = []
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (!item) break
    items.push(unquote(item[1]))
  }
  return items
}

/** `owner/repository` of a source URL, or null. */
export function repositoryName(url) {
  try {
    // `owner/name` from the last two path segments. A plain git URL can have
    // more segments (a group) or one (then the host is the owner).
    const parsed = new URL(url)
    const parts = parsed.pathname.split("/").filter(Boolean)
    const name = parts.at(-1)
    const owner = parts.length > 1 ? parts.at(-2) : parsed.hostname
    const clean = (name ?? "").replace(/\.git$/i, "")
    return owner && clean && SAFE_NAME.test(owner) && SAFE_NAME.test(clean)
      ? `${owner}/${clean}`
      : null
  } catch {
    return null
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/

function readIndex(step) {
  if (!existsSync(step.indexFile)) return []
  const entries = JSON.parse(readFileSync(step.indexFile, "utf8")).entries
  return Array.isArray(entries) ? entries : []
}

/** Lower case, letters and digits only: "@Org/Drizzle-ORM" and "org drizzle orm" are equal. */
export function nameKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/** The path of an index entry of `kind` whose title is one of `names`, or null. */
export function findExisting(index, kind, names) {
  const keys = new Set(names.map(nameKey).filter(Boolean))
  const hits = index
    .filter((e) => e.kind === kind && keys.has(nameKey(e.title)))
    .map((e) => e.path)
    .sort()
  return hits[0] ?? null
}

/** Text of `path` at the step's base commit, or null. */
function baseText(step, path) {
  const blob = baseBlob(step, path)
  return blob ? blobContent(step, blob).toString("utf8") : null
}

/** YAML double-quoted scalar; JSON strings are valid YAML. */
const q = (text) => JSON.stringify(String(text))

function claimYaml(claim, indent) {
  const pad = " ".repeat(indent)
  return [
    `${pad}- to: ${q(claim.to)}`,
    `${pad}  predicate: ${claim.predicate}`,
    `${pad}  evidence:`,
    `${pad}    path: ${q(claim.evidence.path)}`,
    `${pad}    kind: ${claim.evidence.kind}`,
  ].join("\n")
}

/** Text of a new file. */
function newFile({ kind, name, summary, intro, claims, related }) {
  const yaml = [`kind: ${kind}`, `name: ${q(name)}`, `summary: ${q(summary)}`]
  if (claims.length) yaml.push("claims:", ...claims.map((c) => claimYaml(c, 2)))
  const lines = related.slice(0, MAX_RELATED_LINES)
  return `---\n${yaml.join("\n")}\n---\n\n# ${name}\n\n${intro}\n\n## Related\n\n${lines.join("\n")}\n`
}

const YAML_ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
}

/** Text of a YAML double-quoted body with its escapes decoded, or null for an escape it does not know. */
function decodeDoubleQuoted(body) {
  let out = ""
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i]
      continue
    }
    const code = body[++i]
    const width = { x: 2, u: 4, U: 8 }[code]
    if (width) {
      const hex = body.slice(i + 1, i + 1 + width)
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null
      const point = Number.parseInt(hex, 16)
      if (point > 0x10ffff) return null
      out += String.fromCodePoint(point)
      i += width
    } else if (code !== undefined && Object.hasOwn(YAML_ESCAPES, code))
      out += YAML_ESCAPES[code]
    else return null
  }
  return out
}

function trimYamlWhitespace(text) {
  let start = 0
  let end = text.length
  while (start < end && (text[start] === " " || text[start] === "\t")) start++
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--
  return text.slice(start, end)
}

function stripYamlComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === '"') {
      if (c === "\\") i++
      else if (c === '"') quote = null
    } else if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") i++
      else if (c === "'") quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === "#" && (text[i - 1] === " " || text[i - 1] === "\t"))
      return text.slice(0, i - 1)
  }
  return text
}

/**
 * A character that JS trims as space or treats as a line end, but YAML does
 * not: the script refuses it in a claim target, so it never decodes a value
 * shorter or longer than the validator does.
 */
const UNSAFE_TARGET_CHAR =
  /[\p{Cc}\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/u

/**
 * The value of a YAML `to:` scalar on one line: double quoted, single quoted,
 * or plain. Null for any value that this function cannot decode in full (a
 * block scalar, a flow value, an anchor, a tag, an unknown escape, a quote
 * that does not close on the line, a space or line-end character that YAML
 * does not treat as JS does). A caller never treats null as a match.
 */
function claimTarget(raw) {
  // Only an ASCII space or tab is YAML white space.
  const text = trimYamlWhitespace(raw)
  let value = null
  if (text.startsWith('"')) {
    const end = /^"((?:[^"\\]|\\.)*)"[ \t]*$/.exec(stripYamlComment(text))
    value = end ? decodeDoubleQuoted(end[1]) : null
  } else if (text.startsWith("'")) {
    const end = /^'((?:[^']|'')*)'[ \t]*$/.exec(stripYamlComment(text))
    value = end ? end[1].replaceAll("''", "'") : null
  } else if (text !== "" && !/^[|>&*![{%@`#]|^[-?:](?:[ \t]|$)/.test(text)) {
    const plain = trimYamlWhitespace(stripYamlComment(text))
    value = plain.includes(": ") || plain.endsWith(":") ? null : plain
  }
  return value === null || UNSAFE_TARGET_CHAR.test(value) ? null : value
}

/** A value that is a flow collection other than an empty one, or a quote that does not close on its line. */
function unreadableValue(value) {
  const text = value.replace(/^[ \t]+/, "")
  if (/^[[{]/.test(text)) return !/^(?:\[\]|\{\})[ \t]*(?:#.*)?$/.test(text)
  if (text.startsWith('"'))
    return !/^"(?:[^"\\]|\\.)*"(?:[ \t]*|[ \t]+#.*)$/.test(text)
  if (text.startsWith("'"))
    return !/^'(?:[^']|'')*'(?:[ \t]*|[ \t]+#.*)$/.test(text)
  return false
}

/** True when a value that opens a flow collection or a quote closes on the same line. */
function closesOnLine(value) {
  const text = value.replace(/^[ \t]+/, "")
  if (!/^[[{"']/.test(text)) return true
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      for (; j < text.length; j++) {
        if (c === '"' && text[j] === "\\") j++
        else if (text[j] === c) {
          if (c === "'" && text[j + 1] === "'") j++
          else break
        }
      }
      if (j >= text.length) return false
      i = j
    } else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") depth--
    else if (c === "#" && /[ \t]/.test(text[i - 1] ?? "")) break
    if (depth === 0 && i === text.length - 1) break
  }
  return depth === 0
}

/** The claim predicate of a YAML value on one line: plain, or quoted with the same quote on both sides. */
function claimPredicate(raw) {
  const text = trimYamlWhitespace(stripYamlComment(raw))
  const match = /^(?:"([A-Z0-9_]+)"|'([A-Z0-9_]+)'|([A-Z0-9_]+))[ \t]*$/.exec(
    text,
  )
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

/**
 * Claims already in a front matter block, as "to predicate" with the target
 * decoded: the validator rewrites the quotes, so a path with a space can be
 * plain, single quoted, or double quoted.
 *
 * The reader follows the YAML structure. The sandbox has no YAML parser, so
 * it reads only what it can read with certainty: a top-level key at column
 * 0, then the `claims:` list item by item. In a claim item it reads only the
 * keys at the item's key column, and it forgets the target and the
 * predicate at each new item. A line that is deeper than those keys belongs
 * to a nested value (such as a block scalar) and the reader skips it. Null
 * means "cannot read", and the caller skips the file: a block scalar or flow
 * value or a multi-line quote in the claims, a target or predicate that
 * continues on the next line, a duplicate key, a tab as indent, an unusual
 * line end, or a `to` with a character that YAML and JS read as different
 * white space. It never infers a claim.
 */
export function existingClaims(yaml) {
  if (/[\u0085\u2028\u2029]/.test(yaml)) return null
  const lines = yaml.split("\n").map((l) => l.replace(/\r$/, ""))
  if (lines.some((l) => l.includes("\r") || /^ *\t/.test(l))) return null
  const found = new Set()
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (/^ *$/.test(text) || /^ *#/.test(text)) continue
    rows.push({ text, indent: /^ */.exec(text)[0].length })
  }
  let section = null
  let seenClaims = false
  let itemColumn = null
  let keyColumn = null
  let item = null
  const endItem = () => {
    if (item?.to != null && item.predicate != null)
      found.add(`${item.to} ${item.predicate}`)
    item = null
  }
  const read = (key, value, next) => {
    if (key !== "to" && key !== "predicate") {
      if (unreadableValue(value)) return false
      return true
    }
    if (item[key] !== undefined) return false
    const parsed = key === "to" ? claimTarget(value) : claimPredicate(value)
    if (parsed === null) return false
    // A deeper next line continues the value: a folded scalar.
    if (next && next.indent > keyColumn) return false
    item[key] = parsed
    return true
  }
  for (let r = 0; r < rows.length; r++) {
    const { text, indent } = rows[r]
    if (indent === 0 && !(section === "claims" && text.startsWith("-"))) {
      // A top-level list under another key may sit at column 0.
      if (section !== "claims" && /^-(?: |$)/.test(text)) continue
      const top = /^([^\s"'#?:[\]{}&*!|>%@`,-][^:]*):(?:[ \t]+(.*))?$/.exec(
        text,
      )
      if (!top || !closesOnLine(top[2] ?? "")) return null
      endItem()
      itemColumn = null
      keyColumn = null
      section = top[1]
      if (section !== "claims") continue
      if (seenClaims) return null
      seenClaims = true
      const rest = (top[2] ?? "").trim()
      if (rest !== "" && !/^(?:\[\][ \t]*(?:#.*)?|#.*)$/.test(rest)) return null
      if (rest.startsWith("[]")) section = "claims-empty"
      continue
    }
    if (section === "claims-empty") return null
    if (section !== "claims") continue
    const dash = /^( *)-(?: +(.*))?$/.exec(text)
    if (dash && (itemColumn === null || indent === itemColumn)) {
      endItem()
      itemColumn = indent
      item = {}
      keyColumn = null
      const inline = dash[2]
      if (inline === undefined || inline.startsWith("#")) continue
      keyColumn = text.length - inline.length
      const key = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(inline)
      if (!key) return null
      if (!read(key[1], key[2] ?? "", rows[r + 1])) return null
      continue
    }
    if (item === null) return null
    if (keyColumn === null) {
      if (indent <= itemColumn) return null
      keyColumn = indent
    }
    if (indent > keyColumn) continue
    if (indent !== keyColumn) return null
    const key = /^ *([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(text)
    if (!key) return null
    if (!read(key[1], key[2] ?? "", rows[r + 1])) return null
  }
  endItem()
  return found
}

/** Front matter with the new claims, or null when the claims key has a form this script does not edit. */
function withClaims(yaml, claims) {
  const lines = yaml.replace(/\n$/, "").split("\n")
  const at = lines.findIndex((l) => /^claims:/.test(l))
  if (at === -1)
    return `${[...lines, "claims:", ...claims.map((c) => claimYaml(c, 2))].join("\n")}\n`
  const rest = lines[at].slice("claims:".length).trim()
  if (rest === "[]") {
    const copy = [...lines]
    copy.splice(at, 1, "claims:", ...claims.map((c) => claimYaml(c, 2)))
    return `${copy.join("\n")}\n`
  }
  if (rest !== "" && !rest.startsWith("#")) return null
  let end = at + 1
  let indent = null
  while (end < lines.length && /^(\s|-|$)/.test(lines[end])) {
    const item = /^(\s*)-\s/.exec(lines[end])
    if (item && indent === null) indent = item[1].length
    end++
  }
  const copy = [...lines]
  copy.splice(end, 0, ...claims.map((c) => claimYaml(c, indent ?? 2)))
  return `${copy.join("\n")}\n`
}

/**
 * Add claims and Related lines to an existing file, as the validator's
 * additive update allows. Returns the new text, the same text when nothing
 * is new, or { skip } with a reason.
 */
function mergeFile(text, { claims, related }) {
  const front = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!front) return { skip: "The file has no front matter" }
  const yaml = front[1]
  const body = text.slice(front[0].length)
  const known = existingClaims(yaml)
  if (known === null && claims.length)
    return { skip: "The file has claims that the script cannot read" }
  const newClaims = claims.filter((c) => !known?.has(`${c.to} ${c.predicate}`))
  let header = front[0]
  if (newClaims.length) {
    const next = withClaims(yaml, newClaims)
    if (next === null)
      return {
        skip: "The claims of the file have a form that the script does not edit",
      }
    header = `---\n${next}---\n`
  }
  const present = new Set(body.split("\n").map((l) => l.trim()))
  const newLines = related.filter((l) => !present.has(l))
  let nextBody = body
  if (newLines.length) {
    const kept = body.trimEnd()
    const headings = [...kept.matchAll(/^ {0,3}(#{1,6})[ \t]+(.*)$/gm)]
    const last = headings.at(-1)
    const endsInRelated =
      last?.[1] === "##" && /^related[ \t#]*$/i.test(last[2]?.trim() ?? "")
    const room = MAX_RELATED_LINES - present.size
    const lines = newLines.slice(0, Math.max(0, room)).join("\n")
    if (lines)
      nextBody = endsInRelated
        ? `${kept}\n${lines}\n`
        : `${kept}\n\n## Related\n\n${lines}\n`
  }
  return `${header}${nextBody}`
}

/**
 * Write the planned files to the staged tree and write patch.json. A plan is
 * { path, create, claims, related, expectName?, exactName? }. `create` is
 * { kind, name, summary, intro } for a new file, or null when the script
 * only adds to an existing file. When `expectName` is set, an existing file
 * at the path must have that name; letters and digits only, unless
 * `exactName` is set (then the same text, in any letter case). Plans for one path are joined.
 *
 * A step writes at most MAX_STEP_OPS files. `more` is true when a plan waits
 * for the next page: the host runs the skill again on the new base until
 * `more` is false. A file that already has a claim or a line does not
 * change again, so each page continues where the last one stopped.
 * `options.more` adds a page that the caller knows of. `options.stats` are
 * counts (a name to a whole number) for the host. patch.json holds `more` and
 * `stats` for the host. Prints and returns { ops, skipped, more }.
 */
export function writeStep(step, plans, skipped = [], options = {}) {
  const byPath = new Map()
  for (const plan of plans) {
    const same = byPath.get(plan.path)
    if (!same) byPath.set(plan.path, { ...plan })
    else
      byPath.set(plan.path, {
        ...same,
        create: same.create ?? plan.create,
        expectName: same.expectName ?? plan.expectName,
        exactName: same.exactName ?? plan.exactName,
        claims: [...same.claims, ...plan.claims],
        related: [...same.related, ...plan.related],
      })
  }
  let changed = 0
  let more = false
  const sorted = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  for (const plan of sorted) {
    const claims = [
      ...new Map(
        plan.claims.map((c) => [`${c.to} ${c.predicate}`, c]),
      ).values(),
    ]
    const related = [...new Set(plan.related)].sort()
    const before = baseText(step, plan.path)
    const name =
      before === null ? null : frontValue(frontMatter(before) ?? "", "name")
    if (
      plan.expectName &&
      before !== null &&
      (plan.exactName
        ? name?.toLowerCase() !== plan.expectName.toLowerCase()
        : nameKey(name) !== nameKey(plan.expectName))
    ) {
      skipped.push({
        path: plan.path,
        reason: "A file with another name has this path",
      })
      continue
    }
    if (before === null && !plan.create) {
      skipped.push({
        path: plan.path,
        reason: "The file is not in the context",
      })
      continue
    }
    const text =
      before === null
        ? newFile({ ...plan.create, claims, related })
        : mergeFile(before, { claims, related })
    if (typeof text !== "string") {
      skipped.push({ path: plan.path, reason: text.skip })
      continue
    }
    if (text === before) continue
    if (changed >= MAX_STEP_OPS) {
      more = true
      break
    }
    const file = stagedFile(step, plan.path)
    ensureParent(file)
    writeFileSync(file, text)
    changed++
  }
  more ||= options.more === true
  const ops = writePatch(step, { more, stats: options.stats }).map(
    ({ op, path }) => ({ op, path }),
  )
  const result = { ops, skipped, more }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

/** Relative link from one context file to another. */
export function relativeTo(from, to) {
  return posix.relative(posix.dirname(from), to)
}
