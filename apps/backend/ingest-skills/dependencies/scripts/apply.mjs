#!/usr/bin/env node
// dependencies, step 2: write the files for the model's resolutions. The
// model chose, for each candidate id, a target: a Service or API file of the
// context, or a stream. This script re-runs the scan, so the evidence path
// of each claim comes from the script and not from the model. It checks each
// choice and writes the claims of the root's Service files (DEPENDS_ON,
// CONSUMES_API, PRODUCES_TO, CONSUMES_FROM) and the Stream files. A Stream
// file that already describes the stream gets a new Related line, and no
// second file is made. Each Service file also gets an identity line for
// each resolved candidate (`dependencyLine`), which the cursor counts. The
// model never types a path, a claim, or a text into a file.
//
// node apply.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> [--path <root path>] \
//   --resolutions /ctxpipe/out/resolutions.json
//
// With --path (a root step), the claims of that root; a stream resolves only
// to a Stream file that exists. Without --path (the repository-wide step),
// each resolution names its `root`, only streams resolve, and the script
// writes the Stream files and their Related lines.

import { readFileSync, statSync } from "node:fs"
import { posix } from "node:path"

import {
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail, STEP_LIMITS } from "../../bin/stage-lib.mjs"
import { safePath } from "../../discover-roots/scripts/roots-lib.mjs"
import {
  dependencyLine,
  resolvedIds,
  scan,
  stepCandidateCount,
  stepCandidates,
  stepRoots,
  stepStats,
  streamLine,
} from "./scan-lib.mjs"

const STREAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/

const { step, source, repository, roots, rootPath, index, skipped, value } =
  scriptStep()
const resolutionsFile =
  value("--resolutions") ?? fail("Give --resolutions <file>")
// A root step (--path) writes the claims of its root and claims only a
// Stream file that exists. The repository-wide step (no --path) writes the
// Stream files, which more than one root can share (ADR-052 section 6).
const repositoryStep = rootPath === null
if (!repositoryStep && !roots.some((r) => r.path === rootPath))
  fail(`${rootPath} is not a root in the roots file`)

// The counts go to patch.json for the host: a name and a whole number, with no
// path and no text of the source or the context.
const stats = {}
const count = (name, by = 1) => {
  stats[name] = (stats[name] ?? 0) + by
}

/** The scan of one root, once for each root. */
const scans = new Map()
function scanOf(current) {
  let found = scans.get(current.path)
  if (!found) {
    found = scan({
      source,
      path: current.path,
      otherRoots: roots.map((r) => r.path),
      index,
      own: new Set(current.files.map((f) => f.path)),
    })
    skipped.push(...found.skipped)
    scans.set(current.path, found)
  }
  return found
}
const entryAt = (p) => index.find((e) => e.path === p)

/** The roots of the step and their candidates (`scan.mjs --count` counts them). */
const rootsOfStep = stepRoots(roots, rootPath)
const candidatesOf = (root) =>
  stepCandidates(scanOf(root).candidates, repositoryStep)
const candidateCount = stepCandidateCount(roots, rootPath, scanOf)

// The resolutions file has no count limit (CTX-1487). Its size limit
// protects the parse: 1 KiB for each candidate of the step, at least
// 256 KiB, so that a page can resolve each candidate.
const maxBytes = 1024 * Math.max(256, candidateCount)
let resolutions = []
try {
  if (statSync(resolutionsFile).size > maxBytes)
    fail(`${resolutionsFile} is larger than ${maxBytes} bytes`)
  const parsed = JSON.parse(readFileSync(resolutionsFile, "utf8"))
  resolutions = Array.isArray(parsed?.resolutions) ? parsed.resolutions : []
} catch (error) {
  fail(`${resolutionsFile} is not JSON: ${error.message}`)
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const plans = []
const skip = (id, reason, code) => {
  count(`skipped.${code}`)
  skipped.push({ path: null, reason: `${id}: ${reason}` })
}
const noService = new Set()
/**
 * The budgets of the dependency list of a Service file in the shared writer
 * (`listPlans` of knowledge-lib.mjs, CTX-1487). The claims go to the
 * Service file while that file stays at most 56 KiB with at most 150
 * claims, so that the other skills keep room in it. The identity lines go
 * to the Service file while that file stays at most 32 KiB. The next ones
 * go to the parts of the list. A candidate is resolved only when its claim
 * and its line both exist (`resolvedIds`), so the order of the files does
 * not matter.
 */
const SERVICE_LIST = {
  claims: { bytes: STEP_LIMITS.fileBytes - 8 * 1024, claims: 150 },
  lines: { bytes: STEP_LIMITS.fileBytes / 2 },
}

for (const resolution of resolutions) {
  if (!resolution || typeof resolution !== "object") continue
  const id =
    typeof resolution.id === "string" ? resolution.id.slice(0, 20) : "?"
  const at = repositoryStep ? resolution.root : rootPath
  const current = roots.find((r) => r.path === at)
  if (!current) {
    skip(
      id,
      "give the root of the candidate (a root of the roots file)",
      "no_root",
    )
    continue
  }
  // Only a Service can DEPENDS_ON, CONSUMES_API, PRODUCES_TO, or CONSUMES_FROM.
  const users = current.files.filter((f) => f.kind === "Service")
  const kindName = ["service", "api", "stream", "ignore"].includes(
    resolution.kind,
  )
    ? resolution.kind
    : "other"
  count(`resolutions.${kindName}`)
  if (!users.length) {
    if (resolution.kind !== "ignore") count("skipped.no_service")
    if (resolution.kind !== "ignore" && !noService.has(current.path)) {
      noService.add(current.path)
      skipped.push({
        path: null,
        reason: `The root ${current.path} has no Service file in the context, so it has no claims`,
      })
    }
    continue
  }
  const candidate = scanOf(current).candidates.find(
    (c) => c.id === resolution.id,
  )
  if (!candidate) {
    skip(id, "no candidate has this id", "unknown_id")
    continue
  }
  const kind = resolution.kind
  if (kind === "ignore") continue
  let target = null
  let predicate = null
  if (kind === "service" || kind === "api") {
    if (repositoryStep) {
      skip(id, "the root step resolves services and APIs", "wrong_step")
      continue
    }
    if (candidate.type === "queue" || candidate.type === "stream") {
      skip(
        id,
        "a queue or stream candidate needs a stream target",
        "wrong_target_kind",
      )
      continue
    }
    const entry = entryAt(resolution.path)
    const kinds = kind === "service" ? ["Service"] : ["API", "Operation"]
    if (!entry || !kinds.includes(entry.kind)) {
      skip(
        id,
        `${String(resolution.path).slice(0, 100)} is not a ${kind} file of the context`,
        "unknown_path",
      )
      continue
    }
    if (current.files.some((f) => f.path === entry.path)) {
      skip(id, "a root does not depend on itself", "self")
      continue
    }
    target = { path: entry.path }
    predicate = kind === "service" ? "DEPENDS_ON" : "CONSUMES_API"
  } else if (kind === "stream") {
    if (!repositoryStep) {
      skip(id, "the repository-wide step resolves streams", "wrong_step")
      continue
    }
    if (candidate.type === "http") {
      skip(
        id,
        "an HTTP candidate needs a service or API target",
        "wrong_target_kind",
      )
      continue
    }
    const direction =
      candidate.direction === "read"
        ? resolution.direction
        : candidate.direction
    if (direction !== "produce" && direction !== "consume") {
      skip(
        id,
        "give direction produce or consume for a config candidate",
        "no_direction",
      )
      continue
    }
    predicate = direction === "produce" ? "PRODUCES_TO" : "CONSUMES_FROM"
    const named =
      typeof resolution.path === "string" ? entryAt(resolution.path) : null
    if (resolution.path !== undefined) {
      if (named?.kind !== "Stream") {
        skip(
          id,
          `${String(resolution.path).slice(0, 100)} is not a Stream file of the context`,
          "unknown_path",
        )
        continue
      }
      target = { path: named.path }
    } else if (
      typeof resolution.name === "string" &&
      STREAM_NAME.test(resolution.name) &&
      slug(resolution.name)
    ) {
      const existing = findExisting(index, "Stream", [resolution.name])
      target = existing
        ? { path: existing }
        : {
            path: `knowledge/streams/${slug(resolution.name)}.md`,
            name: resolution.name,
          }
    } else {
      skip(
        id,
        "give the path of a Stream file, or a stream name of letters, digits, and . _ : -",
        "no_stream_name",
      )
      continue
    }
    plans.push({
      path: target.path,
      claims: [],
      related: [
        streamLine({
          repository,
          predicate,
          root: current.path,
          file: candidate.file,
        }),
      ],
      expectName: target.name,
      create: streamCreate(target.name ?? posix.basename(target.path, ".md")),
      // A Stream file that many roots share continues in parts (CTX-1528).
      list: { evidence: candidate.file },
    })
  } else {
    skip(id, "kind must be service, api, stream, or ignore", "bad_kind")
    continue
  }
  // The identity line holds the target path in a code span.
  if (!safePath(target.path)) {
    skip(
      id,
      "the target path has a character that the script does not quote",
      "unsafe_path",
    )
    continue
  }
  // Each Service file of the root gets the claim and the identity line of
  // the resolution, in its dependency list (`SERVICE_LIST`).
  for (const user of users) {
    const link = relativeTo(user.path, target.path)
    plans.push({
      path: user.path,
      create: null,
      claims: [
        {
          to: link,
          predicate,
          evidence: { path: candidate.file, kind: "model" },
        },
      ],
      related: [
        dependencyLine({
          predicate,
          link,
          repository,
          root: current.path,
          file: candidate.file,
          id: candidate.id,
        }),
      ],
      list: { ...SERVICE_LIST, evidence: candidate.file },
    })
  }
}

/** How a new Stream file starts. */
function streamCreate(name) {
  return {
    kind: "Stream",
    name,
    summary: "A message stream that a source repository uses.",
    intro:
      "A script and a model found this stream in the code of a source repository.",
  }
}

// The candidates of each root of the step, by type, also for a root that no
// resolution reached.
for (const [name, value] of Object.entries(
  stepStats(roots, rootPath, scanOf).stats,
))
  count(name, value)

/**
 * The cursor (CTX-1487): the candidates of `scan.mjs --count` that are
 * resolved (`resolvedIds`) at the step base or in the staged tree. An
 * ignored candidate is never resolved.
 */
const candidatesResolved = () =>
  rootsOfStep.reduce((sum, root) => {
    const done = resolvedIds(step, root, { repositoryStep, repository })
    return sum + candidatesOf(root).filter((c) => done.has(c.id)).length
  }, 0)

// A Service file comes before the Stream files that exist at the step base
// (`claimOrder`), so that a page that ends in the Stream files has resolved
// the candidates of the Stream files that it wrote.
writeStep(step, plans, skipped, {
  stats,
  cursorAt: candidatesResolved,
  claimOrder: "created",
})
