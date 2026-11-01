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
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail } from "../../bin/stage-lib.mjs"
import { scan, stepStats } from "./scan-lib.mjs"

const MAX_RESOLUTIONS = 300
const MAX_STREAM_FILES = 28
const MAX_RESOLUTIONS_BYTES = 256 * 1024
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

let resolutions = []
try {
  if (statSync(resolutionsFile).size > MAX_RESOLUTIONS_BYTES)
    fail(`${resolutionsFile} is larger than ${MAX_RESOLUTIONS_BYTES} bytes`)
  const parsed = JSON.parse(readFileSync(resolutionsFile, "utf8"))
  resolutions = Array.isArray(parsed?.resolutions) ? parsed.resolutions : []
} catch (error) {
  fail(`${resolutionsFile} is not JSON: ${error.message}`)
}
if (resolutions.length > MAX_RESOLUTIONS) {
  skipped.push({
    path: null,
    reason: `The script read only the first ${MAX_RESOLUTIONS} resolutions`,
  })
  count("skipped.too_many", resolutions.length - MAX_RESOLUTIONS)
  resolutions = resolutions.slice(0, MAX_RESOLUTIONS)
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

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const plans = []
const streams = new Set()
const skip = (id, reason, code) => {
  count(`skipped.${code}`)
  skipped.push({ path: null, reason: `${id}: ${reason}` })
}
const noService = new Set()

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
    if (!streams.has(target.path) && streams.size >= MAX_STREAM_FILES) {
      skip(
        id,
        `the step writes at most ${MAX_STREAM_FILES} stream files`,
        "stream_cap",
      )
      continue
    }
    streams.add(target.path)
    const verb = direction === "produce" ? "produces to" : "consumes from"
    plans.push({
      path: target.path,
      claims: [],
      related: [
        `- \`${repository}\` ${verb} it in \`${current.path}\` (\`${candidate.file}\`)`,
      ],
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
writeStep(step, plans, skipped, { stats })
