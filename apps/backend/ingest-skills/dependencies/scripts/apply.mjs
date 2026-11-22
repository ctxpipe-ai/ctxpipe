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
import { fail, STEP_LIMITS, stepTexts } from "../../bin/stage-lib.mjs"
import {
  dependencyLine,
  isListPart,
  listPart,
  listTexts,
  resolvedIds,
  scan,
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
/** The identity lines of this page's resolutions, for each Service file. */
const identities = new Map()

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
    if (!entry || !kinds.includes(entry.kind) || isListPart(entry.path)) {
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
  for (const user of users) {
    const link = relativeTo(user.path, target.path)
    identities.set(user.path, [
      ...(identities.get(user.path) ?? []),
      dependencyLine({
        predicate,
        link,
        file: candidate.file,
        id: candidate.id,
      }),
    ])
    plans.push({
      path: user.path,
      create: null,
      related: [],
      claims: [
        {
          to: link,
          predicate,
          evidence: { path: candidate.file, kind: "model" },
        },
      ],
    })
  }
}

/**
 * The identity lines of one Service file, as plans (CTX-1487). A line that
 * the Service file or a part of its dependency list has already stays where
 * it is. A new line goes to the Service file while the file stays at most
 * half of the file limit, so that the claims of the file always have room.
 * The next lines go to the last part of the list, and to a new part when
 * that one is full. writeStep writes a part after its Service file, so a
 * page that ends between them leaves the candidate not resolved, and the
 * next page writes the line again. The texts come from the step base,
 * because writeStep writes each file from the base and the plans of the page.
 */
function identityPlans(servicePath, lines) {
  const parts = listTexts(
    (paths) => stepTexts(step, paths, { staged: false }),
    servicePath,
  )
  const present = new Set(
    parts.flatMap((part) => part.text.split("\n").map((l) => l.trim())),
  )
  const fresh = [...new Set(lines)].filter((l) => !present.has(l)).sort()
  const room = (n) =>
    n === 1 ? STEP_LIMITS.fileBytes / 2 : STEP_LIMITS.fileBytes - 2048
  const placed = new Map()
  let n = Math.max(1, parts.length)
  let used = Buffer.byteLength(parts[n - 1]?.text ?? "")
  for (const line of fresh) {
    const bytes = Buffer.byteLength(line) + 1
    while (used + bytes > room(n)) {
      n++
      used = Buffer.byteLength(parts[n - 1]?.text ?? "")
    }
    placed.set(n, [...(placed.get(n) ?? []), line])
    used += bytes
  }
  const base = posix.basename(servicePath, ".md")
  return [...placed].map(([part, related]) =>
    part === 1
      ? { path: servicePath, create: null, claims: [], related }
      : {
          path: listPart(servicePath, part),
          claims: [],
          related,
          after: [servicePath],
          expectName: `${base} dependencies ${part}`,
          exactName: true,
          create: {
            kind: "Service",
            name: `${base} dependencies ${part}`,
            summary: `Part ${part} of the dependency list of ${base}.`,
            intro: `This file continues the dependency list of [${base}](${base}.md). A script writes it when the list does not fit in one file.`,
          },
        },
  )
}
for (const [servicePath, lines] of identities)
  plans.push(...identityPlans(servicePath, lines))

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
