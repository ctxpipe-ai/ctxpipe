#!/usr/bin/env node
// dependencies, step 2: write the files for the model's resolutions. The
// model chose, for each candidate id, a target: a Service or API file of the
// context, or a stream. This script re-runs the scan, so the evidence path
// of each claim comes from the script and not from the model. It checks each
// choice and writes the claims of the root's Service files (DEPENDS_ON,
// CONSUMES_API, PRODUCES_TO, CONSUMES_FROM) and the Stream files. A Stream
// file that already describes the stream gets a new Related line, and no
// second file is made. The model never types a path, a claim, or a text into
// a file.
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
  fileClaims,
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail, stepTexts } from "../../bin/stage-lib.mjs"
import {
  claimGroups,
  scan,
  stepCandidates,
  stepRoots,
  stepStats,
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
const candidateCount = rootsOfStep.reduce(
  (sum, root) => sum + candidatesOf(root).length,
  0,
)

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
 * `<root> <candidate id>` to what this page's resolution of the candidate
 * writes: `{ path, claim }` for each Service file, or `{ path, line }` for
 * the Related line of its Stream file; null for an ignored candidate. The
 * cursor counts them.
 */
const written = new Map()
/** The Service claims of the stream resolutions of this page. */
const streamClaims = []

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
  if (kind === "ignore") {
    const key = `${current.path} ${candidate.id}`
    if (!written.has(key)) written.set(key, null)
    continue
  }
  let target = null
  let predicate = null
  let line = null
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
    const verb = direction === "produce" ? "produces to" : "consumes from"
    line = `- \`${repository}\` ${verb} it in \`${current.path}\` (\`${candidate.file}\`)`
    plans.push({
      path: target.path,
      claims: [],
      related: [line],
      expectName: target.name,
      create: {
        kind: "Stream",
        name: target.name ?? posix.basename(target.path, ".md"),
        summary: "A message stream that a source repository uses.",
        intro:
          "A script and a model found this stream in the code of a source repository.",
      },
    })
  } else {
    skip(id, "kind must be service, api, stream, or ignore", "bad_kind")
    continue
  }
  const claims = users.map((user) => ({
    path: user.path,
    claim: `${relativeTo(user.path, target.path)} ${predicate}`,
  }))
  written.set(
    `${current.path} ${candidate.id}`,
    line ? [{ path: target.path, line }] : claims,
  )
  if (line) streamClaims.push(...claims)
  for (const user of users)
    plans.push({
      path: user.path,
      create: null,
      related: [],
      claims: [
        {
          to: relativeTo(user.path, target.path),
          predicate,
          evidence: { path: candidate.file, kind: "model" },
        },
      ],
    })
}

// The candidates of each root of the step, by type, also for a root that no
// resolution reached.
for (const [name, value] of Object.entries(
  stepStats(roots, rootPath, scanOf).stats,
))
  count(name, value)

/**
 * The cursor (CTX-1487): the candidates of `scan.mjs --count` that are
 * resolved, at the step base or in the staged tree. An ignored candidate is
 * never resolved.
 *
 * - A candidate that this page resolves: what the resolution writes exists.
 *   That is its claim on each Service file of its root (root step), or its
 *   Related line in its Stream file (repository-wide step). writeStep
 *   writes a Stream file before the Service files that claim it, so the
 *   Related line is the first thing that a stream resolution writes.
 * - For each source file, at least the candidates that the claims of the
 *   Service files resolve (`claimGroups`): an earlier page wrote them.
 *
 * The Service files come after the Stream files. While a Service file does
 * not have the claim of a stream resolution of this page, the last
 * candidate is not done: a page that ends before the Service files does not
 * reach the end of the input.
 */
function candidatesResolved() {
  const texts = stepTexts(step, [
    ...[...written.values()].flatMap((parts) =>
      (parts ?? []).map((p) => p.path),
    ),
    ...streamClaims.map((part) => part.path),
  ])
  const textOf = (path) => texts.get(path) ?? ""
  /** What this page's resolution of a candidate writes exists. */
  const writtenNow = (key) =>
    written.get(key)?.every((part) =>
      part.claim
        ? fileClaims(textOf(part.path))?.has(part.claim)
        : textOf(part.path)
            .split("\n")
            .some((line) => line.trim() === part.line),
    ) === true
  let at = 0
  for (const root of rootsOfStep) {
    for (const group of claimGroups(
      step,
      root,
      candidatesOf(root),
      repositoryStep,
    )) {
      const now = group.members.filter((candidate) =>
        writtenNow(`${root.path} ${candidate.id}`),
      ).length
      at += Math.max(now, group.resolved)
    }
  }
  if (
    streamClaims.some((part) => !fileClaims(textOf(part.path))?.has(part.claim))
  )
    at = Math.min(at, Math.max(0, candidateCount - 1))
  return at
}

writeStep(step, plans, skipped, { stats, cursorAt: candidatesResolved })
