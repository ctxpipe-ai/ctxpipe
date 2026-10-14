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
 * Arguments: --root <dir> --source <checkout> --source-url <url> --roots <file>.
 *
 * The roots file is the host's root-to-file map (ADR-052 section 6):
 *   { "roots": [{ "path", "manifests", "evidence", "files": ["knowledge/..."] }] }
 * `files` are the context files that the root steps of the root wrote. Only
 * a file that exists at the base commit and whose `sources` hold the source
 * URL counts. Each root in the result has `files: [{ path, kind }]`.
 */
export function scriptStep(argv = process.argv.slice(2)) {
  const { root, args } = parseArgs(argv)
  const value = (name) => {
    const at = args.indexOf(name)
    return at === -1
      ? null
      : (args[at + 1] ?? fail(`Give a value after ${name}`))
  }
  const source = value("--source") ?? fail("Give --source <checkout>")
  const sourceUrl = value("--source-url") ?? fail("Give --source-url <url>")
  const rootsFile = value("--roots") ?? fail("Give --roots <roots file>")
  const repository = repositoryName(sourceUrl)
  if (!repository) fail(`${sourceUrl} is not a repository URL`)
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
      const file = sourceFile(step, path, sourceUrl)
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
  return { step, source, repository, roots, index: readIndex(step), skipped }
}

/** { path, kind } of a context file at the base commit whose sources hold `sourceUrl`, or null. */
function sourceFile(step, path, sourceUrl) {
  if (
    !safePath(path) ||
    !path.startsWith("knowledge/") ||
    !path.endsWith(".md")
  )
    return null
  const text = baseText(step, path)
  const yaml = text && frontMatter(text)
  if (!yaml || !frontList(yaml, "sources").includes(sourceUrl)) return null
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
    const [owner, name] = new URL(url).pathname.split("/").filter(Boolean)
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

/** The value of a YAML `to:` scalar: double quoted, single quoted, or plain (the rest of the line). */
function claimTarget(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (text.startsWith("'")) {
    const end = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text)
    return end ? end[1].replaceAll("''", "'") : null
  }
  return text.replace(/\s+#.*$/, "")
}

/**
 * Claims already in a front matter block, as "to predicate" with the target
 * decoded: the validator rewrites the quotes, so a path with a space can be
 * plain, single quoted, or double quoted.
 */
function existingClaims(yaml) {
  const found = new Set()
  let to = null
  for (const line of yaml.split("\n")) {
    const toMatch = /^\s*-?\s*to:(.*)$/.exec(line)
    if (toMatch) to = claimTarget(toMatch[1])
    const predicate = /^\s*predicate:\s*["']?([A-Z0-9_]+)["']?\s*$/.exec(line)
    if (predicate && to) found.add(`${to} ${predicate[1]}`)
  }
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
  const newClaims = claims.filter((c) => !known.has(`${c.to} ${c.predicate}`))
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
 * Prints and returns { ops, skipped, more }.
 */
export function writeStep(step, plans, skipped = []) {
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
  const ops = writePatch(step).map(({ op, path }) => ({ op, path }))
  const result = { ops, skipped, more }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

/** Relative link from one context file to another. */
export function relativeTo(from, to) {
  return posix.relative(posix.dirname(from), to)
}
