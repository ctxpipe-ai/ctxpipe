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
import { discoverRoots } from "../discover-roots/scripts/roots-lib.mjs"
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
export const MAX_STEP_OPS = 30
const MAX_RELATED_LINES = 200

/** Arguments: --root <dir> --source <checkout> --source-url <url> [--roots <file>]. */
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
  const repository = repositoryName(sourceUrl)
  if (!repository) fail(`${sourceUrl} is not a repository URL`)
  const rootsFile = value("--roots")
  const roots = rootsFile
    ? JSON.parse(readFileSync(rootsFile, "utf8")).roots
    : discoverRoots(source).roots
  const step = currentStep(root)
  return { step, source, repository, roots, index: readIndex(step) }
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

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
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
export function baseText(step, path) {
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
export function newFile({ kind, name, summary, intro, claims, related }) {
  const yaml = [`kind: ${kind}`, `name: ${q(name)}`, `summary: ${q(summary)}`]
  if (claims.length) yaml.push("claims:", ...claims.map((c) => claimYaml(c, 2)))
  const lines = related.slice(0, MAX_RELATED_LINES)
  return `---\n${yaml.join("\n")}\n---\n\n# ${name}\n\n${intro}\n\n## Related\n\n${lines.join("\n")}\n`
}

/** Claim targets already in a front matter block: "to predicate". */
function existingClaims(yaml) {
  const found = new Set()
  let to = null
  for (const line of yaml.split("\n")) {
    const toMatch = /^\s*-?\s*to:\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (toMatch) to = toMatch[1]
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
export function mergeFile(text, { claims, related }) {
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
 * Write each planned file to the staged tree and write patch.json. A plan
 * is { path, create: () => text, claims, related }. Prints and returns
 * { ops, skipped }.
 */
export function writeStep(step, plans, skipped = []) {
  let changed = 0
  for (const plan of [...plans].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const before = baseText(step, plan.path)
    const text = before === null ? plan.create() : mergeFile(before, plan)
    if (typeof text !== "string") {
      skipped.push({ path: plan.path, reason: text.skip })
      continue
    }
    if (text === before) continue
    if (changed >= MAX_STEP_OPS) {
      skipped.push({
        path: plan.path,
        reason: `A step writes at most ${MAX_STEP_OPS} files`,
      })
      continue
    }
    const file = stagedFile(step, plan.path)
    ensureParent(file)
    writeFileSync(file, text)
    changed++
  }
  const ops = writePatch(step).map(({ op, path }) => ({ op, path }))
  const result = { ops, skipped }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

/** Relative link from one context file to another. */
export function relativeTo(from, to) {
  return posix.relative(posix.dirname(from), to)
}
