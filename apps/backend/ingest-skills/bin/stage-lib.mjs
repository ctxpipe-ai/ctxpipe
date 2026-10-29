// Shared code of the stage helpers (ctxpipe-stage, ctxpipe-delete,
// ctxpipe-finish). The helpers run inside the ingest sandbox. They write the
// staged tree and patch.json that the host patch validator reads
// (apps/backend/src/domain/ingestion/patch-validator.ts).
//
// Prepare (as root) writes <root>/step.json before each step:
//   { "workspaceId": "<id>", "baseCommit": "<sha>" }
// The context checkout <root>/context/<workspaceId> is read-only and is at
// the step's base commit. The step output goes to <root>/out, which the host
// empties before each step. `--root <dir>` changes the root (default /ctxpipe).

import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path"

/** The helper's own arguments, without `--root <dir>`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const at = argv.indexOf("--root")
  if (at === -1) return { root: "/ctxpipe", args: argv }
  const root = argv[at + 1]
  if (!root) fail("Give a folder after --root")
  return { root, args: [...argv.slice(0, at), ...argv.slice(at + 2)] }
}

export function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export function currentStep(root) {
  const file = join(root, "step.json")
  if (!existsSync(file)) fail(`No step is active: ${file} does not exist`)
  const { workspaceId, baseCommit } = JSON.parse(readFileSync(file, "utf8"))
  if (
    typeof workspaceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(workspaceId) ||
    typeof baseCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(baseCommit)
  )
    fail(`${file} does not name a Workspace and a base commit`)
  const stepDir = join(root, "out")
  return {
    baseCommit,
    stepDir,
    contextDir: join(root, "context", workspaceId),
    indexFile: join(root, "context", `${workspaceId}.index.json`),
    filesDir: join(stepDir, "files"),
    deletesFile: join(stepDir, "deletes.json"),
    stagedFile: join(stepDir, "staged.json"),
  }
}

/** A path relative to the context root. An absolute path in the context or staged tree is accepted. */
export function contextPath(step, input) {
  if (!input) fail("Give a path, for example knowledge/services/billing.md")
  let path = input
  for (const base of [step.contextDir, step.filesDir]) {
    if (isAbsolute(path) && !relative(base, path).startsWith("..")) {
      path = relative(base, path)
      break
    }
  }
  if (isAbsolute(path)) fail(`${input} is not in the context checkout`)
  const clean = posix.normalize(path.split(sep).join("/"))
  if (clean === "." || clean.startsWith("../") || clean === "..")
    fail(`${input} is outside the context checkout`)
  return clean
}

function git(contextDir, args, input) {
  return execFileSync("git", ["-C", contextDir, ...args], {
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** The blob id of `path` at the step's base commit, or null. */
export function baseBlob(step, path) {
  const out = git(step.contextDir, [
    "ls-tree",
    "-z",
    step.baseCommit,
    "--",
    path,
  ])
    .toString("utf8")
    .split("\0")
    .find((line) => line.endsWith(`\t${path}`))
  if (!out) return null
  const [mode, type, id] = out.split("\t")[0].split(" ")
  return type === "blob" && mode !== "120000" ? id : null
}

export function blobContent(step, id) {
  return git(step.contextDir, ["cat-file", "blob", id])
}

export function contentBlob(step, file) {
  return git(step.contextDir, ["hash-object", "--no-filters", "--", file])
    .toString("utf8")
    .trim()
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Deletes: path to { baseBlob, reason }. */
export const readDeletes = (step) => readJson(step.deletesFile)
export const writeDeletes = (step, deletes) =>
  writeJson(step.deletesFile, deletes)

/** The base blob that ctxpipe-stage recorded: path to blob id, or null for a new file. */
export const readStaged = (step) => readJson(step.stagedFile)
export const writeStaged = (step, staged) => writeJson(step.stagedFile, staged)

export function stagedFile(step, path) {
  return join(step.filesDir, ...path.split("/"))
}

export function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true })
}

export function removeStaged(step, path) {
  rmSync(stagedFile(step, path), { force: true })
}

/** Each staged path, sorted. A symlink or other special file stops the helper. */
export function stagedPaths(step) {
  const paths = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(join(dir, name))
      if (stat.isDirectory()) walk(join(dir, name), path)
      else if (stat.isFile()) paths.push(path)
      else fail(`${path} is not a regular file; stage only regular files`)
    }
  }
  walk(step.filesDir, "")
  return paths
}

/**
 * Write patch.json for the staged tree and the recorded deletes; returns the
 * ops. `more` tells the host that files wait for a next page (ADR-052
 * section 6): the host runs the skill again on the new tip. A later
 * writePatch keeps a `more` that an earlier one wrote in the same step.
 */
export function writePatch(step, options = {}) {
  const recorded = readStaged(step)
  const ops = []
  const staged = new Set(stagedPaths(step))
  for (const path of staged) {
    const blob = path in recorded ? recorded[path] : baseBlob(step, path)
    if (!blob) ops.push({ op: "create", path })
    else if (contentBlob(step, stagedFile(step, path)) !== blob)
      ops.push({ op: "update", path, baseBlob: blob })
  }
  for (const [path, entry] of Object.entries(readDeletes(step))) {
    if (staged.has(path)) fail(`${path} is both staged and deleted`)
    ops.push({
      op: "delete",
      path,
      baseBlob: entry.baseBlob,
      reason: entry.reason,
    })
  }
  ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const earlier = earlierPatch(step)
  const more = options.more === true || earlier.more === true
  // `stats` are counts that the host puts on its step span. A later
  // `ctxpipe-finish` keeps the counts of a script.
  const stats = options.stats
    ? { ...options.stats, ops: ops.length }
    : earlier.stats
  writeJson(join(step.stepDir, "patch.json"), {
    ops,
    ...(more ? { more } : {}),
    ...(stats ? { stats } : {}),
  })
  return ops
}

/** The `more` and `stats` that patch.json of this step already has. */
function earlierPatch(step) {
  try {
    const earlier = JSON.parse(
      readFileSync(join(step.stepDir, "patch.json"), "utf8"),
    )
    return { more: earlier?.more === true, stats: earlier?.stats }
  } catch {
    return { more: false, stats: undefined }
  }
}
