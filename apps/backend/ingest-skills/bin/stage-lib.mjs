// Shared code of the stage helpers (ctxpipe-stage, ctxpipe-delete,
// ctxpipe-finish). The helpers run inside the ingest sandbox. They write the
// staged tree and patch.json that the host patch validator reads
// (apps/backend/src/domain/ingestion/patch-validator.ts).
//
// The host writes <root>/out/step.json before each step:
//   { "stepDir": "<root>/out/<step>", "contextDir": "<root>/context/<workspaceId>" }
// The context directory is a git checkout at the step's base commit.

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

const root = process.env.CTXPIPE_ROOT || "/ctxpipe"

export function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export function currentStep() {
  const file = join(root, "out", "step.json")
  if (!existsSync(file)) fail(`No step is active: ${file} does not exist`)
  const { stepDir, contextDir } = JSON.parse(readFileSync(file, "utf8"))
  const out = join(root, "out")
  if (
    typeof stepDir !== "string" ||
    typeof contextDir !== "string" ||
    relative(out, stepDir).startsWith("..") ||
    isAbsolute(relative(out, stepDir))
  )
    fail(`${file} does not name a step folder under ${out}`)
  return {
    stepDir,
    contextDir,
    filesDir: join(stepDir, "files"),
    deletesFile: join(stepDir, "deletes.json"),
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

/** The blob id of `path` at the context checkout's HEAD, or null. */
export function baseBlob(step, path) {
  const out = git(step.contextDir, ["ls-tree", "-z", "HEAD", "--", path])
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

export function readDeletes(step) {
  if (!existsSync(step.deletesFile)) return {}
  return JSON.parse(readFileSync(step.deletesFile, "utf8"))
}

export function writeDeletes(step, deletes) {
  mkdirSync(step.stepDir, { recursive: true })
  writeFileSync(step.deletesFile, `${JSON.stringify(deletes, null, 2)}\n`)
}

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
