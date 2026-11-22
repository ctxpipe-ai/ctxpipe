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

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { posix } from "node:path"

import { safePath } from "../discover-roots/scripts/roots-lib.mjs"
import {
  baseBlob,
  currentStep,
  ensureParent,
  fail,
  parseArgs,
  readDeletes,
  stagedFile,
  stagedPaths,
  STEP_LIMITS,
  stepTexts,
  writePatch,
} from "./stage-lib.mjs"

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
 * `files` are the context files of the root: the files that the root steps
 * of this run wrote, and the existing files whose front matter `root` is the
 * root. Only a file that exists at the base commit and whose `sources` hold
 * the source path counts. Each root in the result has `files: [{ path, kind }]`.
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
  for (const entry of listed) {
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
    rootsFile,
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

/** The front matter block of a file text, or null. */
export function frontMatter(text) {
  return (
    /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? null
  )
}

const unquote = (text) => text.trim().replace(/^(["'])(.*)\1$/, "$2")

/** A top-level scalar of a front matter block, or null. */
export function frontValue(yaml, key) {
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

/**
 * The entries of the context index, without the parts of a list
 * (`isListPart`): a part is not a Service, a Stream, or a store, so no skill
 * takes one as a target or as an existing file of a name.
 */
function readIndex(step) {
  if (!existsSync(step.indexFile)) return []
  const entries = JSON.parse(readFileSync(step.indexFile, "utf8")).entries
  return Array.isArray(entries)
    ? entries.filter((e) => !isListPart(String(e?.path)))
    : []
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
  return stepTexts(step, [path], { staged: false }).get(path) ?? null
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

/**
 * The bytes of a claim in a file after the validator wrote it: the YAML of
 * the writer and the host fields `confidence` and `valid_from`.
 */
export function claimBytes(claim) {
  return Buffer.byteLength(
    `${claimYaml(claim, 2)}\n    confidence: 0.5\n    valid_from: 2026-01-01T00:00:00.000Z\n`,
  )
}

/** Text of a new file. */
function newFile({ kind, name, summary, intro, claims, related }) {
  const yaml = claims.length
    ? `claims:\n${claims.map((c) => `${claimYaml(c, 2)}\n`).join("")}`
    : ""
  return newText(
    { kind, name, summary, intro },
    yaml,
    `${related.join("\n")}\n`,
  )
}

/** Text of a new file with its claims block (YAML) and its Related lines (text). */
function newText({ kind, name, summary, intro }, claims, related) {
  const yaml = `kind: ${kind}\nname: ${q(name)}\nsummary: ${q(summary)}\n${claims}`
  return `---\n${yaml}---\n\n# ${name}\n\n${intro}\n\n## Related\n\n${related}`
}

/**
 * A file that `newFile` wrote in this step, with the fields of `create`
 * (CTX-1528): a later run of the page can correct the name, the summary, or
 * the intro of a new file. Its claims and its Related lines stay. Null for
 * a text of another form, for example a file that the model staged.
 */
function withCreate(text, create) {
  const found =
    /^---\nkind: [^\n]*\nname: [^\n]*\nsummary: [^\n]*\n((?:claims:\n(?: [^\n]*\n)*)?)---\n\n# [^\n]*\n\n[\s\S]*?\n\n## Related\n\n([\s\S]*)$/.exec(
      text,
    )
  return found ? newText(create, found[1], found[2]) : null
}

/**
 * The bytes of a file after the validator stores it: the host fields of a
 * new file (at most 1 KiB), or of a file at the base (`skill` gets the name
 * of this skill, which can be longer: 64 bytes), and `confidence` for each
 * claim that the base does not have.
 */
function storedBytes(text, base) {
  const newClaims =
    (fileClaims(text)?.size ?? 0) - (fileClaims(base ?? "")?.size ?? 0)
  return (
    Buffer.byteLength(text) +
    (base === null ? 1024 : 64) +
    "    confidence: 0.5\n".length * newClaims
  )
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
    // No count limit (CTX-1487): writeStep skips a file larger than 64 KiB.
    const lines = newLines.join("\n")
    nextBody = endsInRelated
      ? `${kept}\n${lines}\n`
      : `${kept}\n\n## Related\n\n${lines}\n`
  }
  return `${header}${nextBody}`
}

/**
 * Write the planned files to the staged tree and write patch.json. A plan is
 * { path, create, claims, related, expectName?, exactName?, list? }.
 * `create` is { kind, name, summary, intro } for a new file, or null when
 * the script only adds to an existing file. When `expectName` is set, an
 * existing file at the path must have that name; letters and digits only,
 * unless `exactName` is set (then the same text, in any letter case). Plans
 * for one path are joined. A plan with `list` continues in the parts of its
 * list when its file is full (`listPlans`).
 *
 * The writer adds to the file of the step (CTX-1528): the staged file when
 * an earlier run of the page staged it, else the file at the step base. So
 * each run of a page keeps what the runs before it wrote, and a script does
 * not plan that again.
 *
 * A page has no file count (CTX-1482). It ends only before a file that the
 * validator could not take in this step: it takes at most 2 MiB of staged
 * files, and a patch.json of at most 1 MiB and 10,000 ops
 * (patch-validator.ts). The files and deletes that the step staged before
 * count too. A file larger than 64 KiB, or with more than 200 claims, gets
 * a `skipped` entry, because no page can write it. `more` is true when a
 * plan waits for the next page: the host runs the skill again on the new
 * base until `more` is false. A file that
 * already has a claim or a line does not change again, so each page
 * continues where the last one stopped. `options.stats` are counts (a name
 * to a whole number) for the host.
 *
 * The cursor (CTX-1487): the plans, in the order of the writer, are the
 * inputs of the page loop. With `--count`, the script writes nothing and
 * prints `{"count": <plans>}`: the host runs it before the step and takes
 * the count as the length of the input. Else patch.json gets `cursor.at`,
 * the plans that the page handled before it ended. A skill whose input is
 * not its plans (a model writes the plan) gives `options.cursorAt`: a
 * function that counts the inputs that are done after the page wrote its
 * files. A skill that writes lists gives `options.cursorAt`, because the
 * parts of a list change the count of the plans. `options.claimOrder` is
 * described at the order of the plans. patch.json holds `more` and `stats`
 * for the host. Prints and returns { ops, skipped, more }.
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
        list: same.list ?? plan.list,
        claims: [...same.claims, ...plan.claims],
        related: [...same.related, ...plan.related],
      })
  }
  // A plan of a list becomes the plans of the file and of its parts.
  for (const plan of [...byPath.values()].filter((p) => p.list)) {
    byPath.delete(plan.path)
    for (const next of listPlans(step, plan)) byPath.set(next.path, next)
  }
  // The size of an op in patch.json. patch.json has an indent of 2, so an
  // op is 4 spaces deeper than in the JSON of the op alone: 4 bytes for each
  // of its at most 6 lines, and 2 bytes for the comma and the newline.
  const opBytes = (op) =>
    Buffer.byteLength(JSON.stringify(op, null, 2)) + 4 * 6 + 2
  const tailReserve = 64 * 1024 // `more` and `stats` at the end of patch.json
  const room = {
    staged: STEP_LIMITS.stagedBytes,
    patch: STEP_LIMITS.patchBytes - tailReserve,
    ops: STEP_LIMITS.ops,
  }
  const updateOf = (path) => ({ op: "update", path, baseBlob: "0".repeat(40) })
  // The size of each file that the step staged before. A plan that writes
  // the file again uses only the difference.
  const stagedBefore = new Map()
  for (const path of stagedPaths(step)) {
    const size = statSync(stagedFile(step, path)).size
    stagedBefore.set(path, size)
    room.staged -= size
    room.patch -= opBytes(updateOf(path))
    room.ops -= 1
  }
  for (const [path, entry] of Object.entries(readDeletes(step))) {
    room.patch -= opBytes({ op: "delete", path, ...entry })
    room.ops -= 1
  }
  let more = false
  // Path order, but each plan comes after the plans of this step that its
  // claims link to. A page that ends at a size limit then has no claim to a
  // file that the page does not write (an API file and its operations).
  // With `options.claimOrder` "created", a claim orders only before a plan
  // that creates its file: a file at the step base needs no order.
  const sorted = []
  const placed = new Set()
  const atBase = new Map()
  const existsAtBase = (path) => {
    if (!atBase.has(path)) atBase.set(path, baseBlob(step, path) !== null)
    return atBase.get(path)
  }
  const place = (plan) => {
    if (placed.has(plan.path)) return
    placed.add(plan.path)
    for (const claim of plan.claims) {
      const path = posix.normalize(
        posix.join(posix.dirname(plan.path), claim.to),
      )
      const target = byPath.get(path)
      if (target && (options.claimOrder !== "created" || !existsAtBase(path)))
        place(target)
    }
    sorted.push(plan)
  }
  for (const plan of [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  ))
    place(plan)
  if (process.argv.includes("--count")) {
    process.stdout.write(`${JSON.stringify({ count: sorted.length })}\n`)
    return { ops: [], skipped, more: false }
  }
  let at = sorted.length
  for (const [index, plan] of sorted.entries()) {
    const { text, before, skip } = planText(step, plan)
    if (skip) {
      skipped.push({ path: plan.path, reason: skip })
      continue
    }
    if (text === before) continue
    const earlier = stagedBefore.get(plan.path)
    const grows = Buffer.byteLength(text) - (earlier ?? 0)
    const opSize = earlier === undefined ? opBytes(updateOf(plan.path)) : 0
    if (
      grows > room.staged ||
      opSize > room.patch ||
      (earlier === undefined && room.ops < 1)
    ) {
      more = true
      at = index
      break
    }
    room.staged -= grows
    room.patch -= opSize
    if (earlier === undefined) room.ops -= 1
    stagedBefore.set(plan.path, Buffer.byteLength(text))
    const file = stagedFile(step, plan.path)
    ensureParent(file)
    writeFileSync(file, text)
  }
  const ops = writePatch(step, {
    more,
    stats: options.stats,
    cursor: { at: options.cursorAt ? options.cursorAt() : at },
  }).map(({ op, path }) => ({ op, path }))
  const result = { ops, skipped, more }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

/**
 * The plans of a list (CTX-1487, CTX-1528): a file and its parts
 * (`partPath`). A Service file holds the dependency list of `dependencies`.
 * A Stream file and a store file hold the Related lines of the roots that
 * use them. No claim and no line of a list is dropped: when the file is
 * full, the next ones go to a part.
 *
 * The claims go first: a claim goes to the file while the file stays inside
 * `list.claims` (bytes and a claim count), and else to the first part with
 * room. Then the Related lines: a line goes to the file while the file
 * stays inside `list.lines`, and else to the first part with room. A budget
 * that the plan does not give is the budget of a part: the limits of the
 * validator (64 KiB and 200 claims), less a margin. The size of a file
 * counts the host fields that the validator adds (`storedBytes`). A claim
 * or a line that a file of the list has already does not move.
 *
 * A new part has the kind of the file, its name, and a PART_OF claim to
 * the file, with `list.evidence` (a source file) as the evidence. The order
 * of the files does not matter to a reader of the list (`listTexts`). When
 * the file fails the checks of `planText` (another name, or no file and no
 * `create`), the plan stays one plan and gets its `skipped` entry. A file
 * of a folder with no label (`listLabel`) has no parts.
 */
function listPlans(step, plan) {
  const label = listLabel(plan.path)
  const files = label ? listTexts(step, plan.path) : []
  const main = files[0]?.path === plan.path ? files[0] : null
  const kind = main
    ? frontValue(frontMatter(main.text) ?? "", "kind")
    : plan.create?.kind
  if (!label || identityProblem(plan, main?.text ?? null) || !kind)
    return [{ ...plan, list: undefined }]
  const stem = posix.basename(plan.path, ".md")
  const what = label === "dependencies" ? "dependency list" : "Related list"
  const partCreate = (n) => ({
    kind,
    // The validator takes a name of at most 200 characters.
    name: `${stem.slice(0, 150)} ${label} ${n}`,
    summary: `Part ${n} of the ${what} of ${stem}.`,
    intro: `This file continues the ${what} of [${stem}](${stem}.md). A script writes it when the list does not fit in one file.`,
  })
  const partOf = {
    to: `${stem}.md`,
    predicate: "PART_OF",
    evidence: { path: plan.list.evidence, kind: "script" },
  }
  // The size of a file counts the host fields that the validator adds,
  // also for the claims that an earlier run of the page staged.
  const bases = stepTexts(
    step,
    files.map((file) => file.path),
    { staged: false },
  )
  const stateOf = (path, n, text) => {
    const claims = fileClaims(text) ?? new Set()
    return {
      path,
      n,
      lines: new Set(text.split("\n").map((l) => l.trim())),
      claims,
      bytes: storedBytes(text, bases.get(path) ?? null),
      count: claims.size,
      added: new Map(),
      related: [],
    }
  }
  const list = files.map(({ path, n, text }) => stateOf(path, n, text))
  if (!main)
    list.unshift({
      ...stateOf(
        plan.path,
        1,
        newFile({ ...plan.create, claims: [], related: [] }),
      ),
      create: true,
    })
  const limit = STEP_LIMITS.fileBytes
  const part = { bytes: limit - 2048, claims: STEP_LIMITS.claims }
  const room = (i, key) => (i > 0 ? part : { ...part, ...plan.list[key] })
  /** The first file of the list with room, else a new part. */
  const fileFor = (key, bytes) => {
    const at = list.findIndex(
      (file, i) =>
        file.bytes + bytes <= room(i, key).bytes &&
        (key !== "claims" || file.count < room(i, key).claims),
    )
    if (at !== -1) return list[at]
    const n = Math.max(...list.map((file) => file.n)) + 1
    const path = partPath(plan.path, n)
    const text = newFile({ ...partCreate(n), claims: [partOf], related: [] })
    list.push({ ...stateOf(path, n, text), create: true })
    return list.at(-1)
  }
  for (const claim of plan.claims) {
    const key = `${claim.to} ${claim.predicate}`
    if (list.some((f) => f.claims.has(key) || f.added.has(key))) continue
    const file = fileFor("claims", claimBytes(claim))
    file.added.set(key, claim)
    file.bytes += claimBytes(claim)
    file.count++
  }
  for (const line of [...new Set(plan.related)].sort()) {
    if (list.some((f) => f.lines.has(line.trim()))) continue
    const file = fileFor("lines", Buffer.byteLength(line) + 1)
    file.lines.add(line.trim())
    file.related.push(line)
    file.bytes += Buffer.byteLength(line) + 1
  }
  return list.flatMap((file, i) => {
    const claims = [...file.added.values()]
    // The file keeps its plan also with nothing new: a new file of the step
    // can take a corrected `create` (`planText`).
    if (i === 0)
      return [{ ...plan, list: undefined, claims, related: file.related }]
    if (!claims.length && !file.related.length) return []
    const create = partCreate(file.n)
    return [
      {
        path: file.path,
        create,
        claims: file.create ? [partOf, ...claims] : claims,
        related: file.related,
        expectName: create.name,
        exactName: true,
      },
    ]
  })
}

/**
 * The reason why a plan cannot write its file, or null: an existing file
 * with another name, or no file and no `create`. `current` is the text of
 * the file in the step (the staged file, else the file at the step base), or
 * null.
 */
function identityProblem(plan, current) {
  const name =
    current === null ? null : frontValue(frontMatter(current) ?? "", "name")
  if (
    plan.expectName &&
    current !== null &&
    (plan.exactName
      ? name?.toLowerCase() !== plan.expectName.toLowerCase()
      : nameKey(name) !== nameKey(plan.expectName))
  )
    return "A file with another name has this path"
  if (current === null && !plan.create) return "The file is not in the context"
  return null
}

/**
 * The text that writeStep writes for one plan: `{ text, before }`, with the
 * text of the file in the step before the plan (the staged file, else the
 * file at the step base; null for a new file), or `{ skip }` with the
 * reason when the script cannot write the file. A file that is new in this
 * step gets the `create` fields of the plan (`withCreate`). The host fields
 * come from the file at the step base, because the validator compares with
 * that file. The validator refuses a file larger than 64 KiB
 * (also after it adds its fields) in any step. It also refuses a file with
 * more than 200 claims; legacy claims do not count. A next page cannot take
 * such a file either, so it is a skip too, with `tooLarge`.
 */
export function planText(step, plan) {
  const claims = [
    ...new Map(plan.claims.map((c) => [`${c.to} ${c.predicate}`, c])).values(),
  ]
  const related = [...new Set(plan.related)].sort()
  const base = baseText(step, plan.path)
  const file = stagedFile(step, plan.path)
  const before = existsSync(file) ? readFileSync(file, "utf8") : base
  const problem = identityProblem(plan, before)
  if (problem) return { skip: problem }
  // A file that is new in this step takes the `create` of the last plan.
  const current =
    base === null && before !== null && plan.create
      ? (withCreate(before, plan.create) ?? before)
      : before
  const text =
    current === null
      ? newFile({ ...plan.create, claims, related })
      : mergeFile(current, { claims, related })
  if (typeof text !== "string") return { skip: text.skip }
  const legacy =
    frontMatter(text)?.match(/^ +kind: legacy[ \t]*$/gm)?.length ?? 0
  const claimCount = fileClaims(text)?.size ?? 0
  // The validator checks the file that it stores, too (`storedBytes`).
  if (
    text !== before &&
    (storedBytes(text, base) > STEP_LIMITS.fileBytes ||
      claimCount - legacy > STEP_LIMITS.claims)
  )
    return {
      skip: `The file would be larger than ${STEP_LIMITS.fileBytes / 1024} KiB or have more than ${STEP_LIMITS.claims} claims, so the script does not write it`,
      tooLarge: true,
    }
  return { text, before }
}

/**
 * The claims of the text of a file, as `existingClaims` gives them: each
 * `<to> <predicate>`, or null when the front matter cannot be read.
 */
export function fileClaims(text) {
  return existingClaims(frontMatter(text) ?? "")
}

/**
 * The label of the parts of a list file, from its folder: `dependencies`
 * for the dependency list of a Service file, `related` for the Related lines
 * of a Stream file or a store file, and null for a file of another folder,
 * which has no parts.
 */
function listLabel(path) {
  const folder = /^knowledge\/([a-z]+)\/./.exec(path)?.[1]
  if (folder === "services") return "dependencies"
  return ["streams", "databases", "infrastructure"].includes(folder)
    ? "related"
    : null
}

/**
 * The path is a part of a list (`listPlans`). A part has the kind of its
 * file, but it is not a Service, a Stream, or a store, so no skill takes one
 * from the context index (`readIndex`). The host keeps a part of a Service
 * file out of the root-to-file map (`isDependencyListPart`, the same rule
 * for `knowledge/services/`); a test checks both. A Stream file and a store
 * file are not package files, so the host needs no rule for their parts.
 */
export function isListPart(path) {
  const label = listLabel(path)
  return (
    label !== null &&
    /^[^/]+\.([a-z]+)-\d+\.md$/.exec(posix.basename(path))?.[1] === label
  )
}

/**
 * The first 100 bytes of a long file stem and a hash of the whole stem: the
 * stem of a part whose full name would be longer than the 255 bytes of a
 * file name (CTX-1528).
 */
function shortStem(stem) {
  let cut = ""
  for (const char of stem) {
    if (Buffer.byteLength(cut + char) > 100) break
    cut += char
  }
  return `${cut}-${createHash("sha256").update(stem).digest("hex").slice(0, 16)}`
}

/**
 * Part `n` (2 or more) of the list of a file:
 * `<stem>.<label>-<n>.md` (`listLabel`). When that file name would be longer
 * than 255 bytes, the stem is the short stem (`shortStem`). So each file of
 * any name can have parts, and a part of a shorter name keeps the name that
 * it had before.
 */
function partPath(path, n) {
  const stem = posix.basename(path, ".md")
  const tail = `.${listLabel(path)}-${n}.md`
  const name =
    Buffer.byteLength(`${stem}${tail}`) <= 255 ? stem : shortStem(stem)
  return `${posix.dirname(path)}/${name}${tail}`
}

/** The paths of a folder of the context at the step base, once for each step. */
const listings = new Map()
function baseListing(step, dir) {
  const key = `${step.baseCommit} ${dir}`
  if (!listings.has(key)) {
    const listing = spawnSync(
      "git",
      [
        "-C",
        step.contextDir,
        "ls-tree",
        "-z",
        "--name-only",
        step.baseCommit,
        "--",
        `${dir}/`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
    if (listing.error || listing.status !== 0)
      throw new Error(`git ls-tree failed: ${listing.stderr}`)
    listings.set(key, listing.stdout.split("\0").filter(Boolean))
  }
  return listings.get(key)
}

/** The names of the regular files of a folder of the staged tree. */
function stagedNames(step, dir) {
  try {
    return readdirSync(stagedFile(step, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * The texts of a file and of each part of its list that exists at the step
 * base or in the staged tree: `[{ path, n, text }]`, with the part number `n` (1 for the file), in
 * number order. The staged text comes before the text at the base. A part
 * has the full stem or the short stem (`partPath`). writeStep writes the
 * parts in path order (part 10 before part 2), so a page can end with a gap
 * in the numbers: the list reads each part that exists.
 */
export function listTexts(step, path) {
  const stem = posix.basename(path, ".md")
  const dir = posix.dirname(path)
  const prefixes = [stem, shortStem(stem)].map(
    (s) => `${dir}/${s}.${listLabel(path)}-`,
  )
  const numberOf = (file) => {
    const prefix = prefixes.find((p) => file.startsWith(p))
    return prefix
      ? Number(/^([1-9]\d*)\.md$/.exec(file.slice(prefix.length))?.[1] ?? 0)
      : 0
  }
  const parts = new Set(baseListing(step, dir).filter(numberOf))
  for (const name of stagedNames(step, dir))
    if (numberOf(`${dir}/${name}`)) parts.add(`${dir}/${name}`)
  const paths = [path, ...[...parts].sort((a, b) => numberOf(a) - numberOf(b))]
  const texts = stepTexts(step, paths)
  return paths
    .filter((file) => texts.has(file))
    .map((file) => ({
      path: file,
      n: file === path ? 1 : numberOf(file),
      text: texts.get(file),
    }))
}

/** Relative link from one context file to another. */
export function relativeTo(from, to) {
  return posix.relative(posix.dirname(from), to)
}

/** The lines of a file and of the parts of its list (`listTexts`), trimmed. */
export function listLines(step, path) {
  return new Set(
    listTexts(step, path).flatMap((part) =>
      part.text.split("\n").map((line) => line.trim()),
    ),
  )
}
