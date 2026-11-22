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

/**
 * The step limits of the host patch validator (patch-validator.ts): a file
 * of at most 64 KiB, at most 2 MiB of staged files, and a patch.json of at
 * most 1 MiB and 10,000 ops.
 */
export const STEP_LIMITS = {
  fileBytes: 64 * 1024,
  /** Claims of one file, without the legacy claims. */
  claims: 200,
  stagedBytes: 2 * 1024 * 1024,
  patchBytes: 1024 * 1024,
  ops: 10_000,
}

/**
 * The size limit of a list that the model reads (CTX-1487): a list has no
 * count limit, but its JSON ends at 128 KiB. `take(item)` is true while the
 * item fits. After the first item that does not fit, `take` is always
 * false, and `more()` is true: the model writes the listed inputs and runs
 * the script again for the next ones.
 */
export function outputBudget() {
  let room = 128 * 1024
  let more = false
  return {
    take(item) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (more || size > room) {
        more = true
        return false
      }
      room -= size
      return true
    },
    more: () => more,
  }
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

// The file blobs of each base commit: path to blob id. A commit does not
// change, so one `git ls-tree` gives each later baseBlob call its answer.
// A script that reads the base for each of 600 files then starts one git
// process, not 600.
const baseBlobsOf = new Map()

/** The blob id of `path` at the step's base commit, or null. */
export function baseBlob(step, path) {
  const key = `${step.contextDir}\0${step.baseCommit}`
  let blobs = baseBlobsOf.get(key)
  if (!blobs) {
    blobs = new Map()
    const out = execFileSync(
      "git",
      [
        "-C",
        step.contextDir,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        step.baseCommit,
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    ).toString("utf8")
    for (const line of out.split("\0")) {
      const tab = line.indexOf("\t")
      if (tab === -1) continue
      const [mode, type, id] = line.slice(0, tab).split(" ")
      // A symbolic link or a submodule is not a file blob.
      if (type === "blob" && mode !== "120000")
        blobs.set(line.slice(tab + 1), id)
    }
    baseBlobsOf.set(key, blobs)
  }
  return blobs.get(path) ?? null
}

export function blobContent(step, id) {
  return git(step.contextDir, ["cat-file", "blob", id])
}

/**
 * The text of each path in the step: the staged file, else the file at the
 * step base, with one `git cat-file --batch` for all of them. A path that is
 * in neither has no entry. With `{ staged: false }`, only the step base.
 */
export function stepTexts(step, paths, { staged = true } = {}) {
  const texts = new Map()
  const base = []
  for (const path of new Set(paths)) {
    const file = stagedFile(step, path)
    if (staged && existsSync(file)) texts.set(path, readFileSync(file, "utf8"))
    else if (!path.includes("\n")) base.push(path)
  }
  if (!base.length) return texts
  const out = git(
    step.contextDir,
    ["cat-file", "--batch"],
    base.map((path) => `${step.baseCommit}:${path}\n`).join(""),
  )
  let at = 0
  for (const path of base) {
    const end = out.indexOf(0x0a, at)
    const size = /^\S+ blob (\d+)$/.exec(out.toString("utf8", at, end))?.[1]
    at = end + 1
    if (size === undefined) continue
    texts.set(path, out.toString("utf8", at, at + Number(size)))
    at += Number(size) + 1
  }
  return texts
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
 * section 6): the host runs the skill again on the new tip. `cursor` is
 * `{ at }`: the inputs of the skill that are done (CTX-1487). A later
 * writePatch keeps the `more`, `stats`, and `cursor` that an earlier one
 * wrote in the same step.
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
  // `ctxpipe-finish` keeps the counts of a script. The span has the number of
  // accepted ops as `ctxpipe.ingest.ops`, so `stats` does not count ops.
  const stats = options.stats ?? earlier.stats
  const cursor = options.cursor ?? earlier.cursor
  writeJson(join(step.stepDir, "patch.json"), {
    ops,
    ...(more ? { more } : {}),
    ...(stats ? { stats } : {}),
    ...(cursor ? { cursor } : {}),
  })
  return ops
}

/** The `more`, `stats`, and `cursor` that patch.json of this step already has. */
function earlierPatch(step) {
  try {
    const earlier = JSON.parse(
      readFileSync(join(step.stepDir, "patch.json"), "utf8"),
    )
    return {
      more: earlier?.more === true,
      stats: earlier?.stats,
      cursor: earlier?.cursor,
    }
  } catch {
    return { more: false, stats: undefined, cursor: undefined }
  }
}
