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
  claimBytes,
  fileClaims,
  findExisting,
  isListPart,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail, STEP_LIMITS } from "../../bin/stage-lib.mjs"
import { safePath } from "../../discover-roots/scripts/roots-lib.mjs"
import {
  dependencyLine,
  listPart,
  parseDependencyLine,
  listTexts,
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
/** The claims and identity lines of this page's resolutions, for each Service file. */
const entries = new Map()

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
  // the resolution, in its dependency list (`listPlans`).
  for (const user of users) {
    const link = relativeTo(user.path, target.path)
    if (!entries.has(user.path)) entries.set(user.path, [])
    entries.get(user.path).push({
      claim: {
        to: link,
        predicate,
        evidence: { path: candidate.file, kind: "model" },
      },
      line: dependencyLine({
        predicate,
        link,
        repository,
        root: current.path,
        file: candidate.file,
        id: candidate.id,
      }),
    })
  }
}

/**
 * The plans of the dependency list of one Service file (CTX-1487): the
 * Service file and its parts (`listPart`). Each entry is a claim and its
 * identity line. The claims go first: a claim goes to the Service file
 * while the file stays at most 56 KiB with at most 150 claims, so that the
 * other skills keep room in it, and else to the first part with room. Then
 * the identity lines: a line goes to the Service file while the file stays
 * at most 32 KiB, and else to the first part with room. A part takes up to
 * the limits of the validator (64 KiB and 200 claims), less a margin for the
 * host fields. A claim or a line that a file of the list has already does
 * not move. A new part has a PART_OF claim to its Service file. The order
 * of the files does not matter: a candidate is resolved only when its claim
 * and its line both exist (`resolvedIds`). The texts come from the step
 * base, because writeStep writes each file from the base and the plans of
 * the page.
 */
function listPlans(servicePath, list) {
  const base = posix.basename(servicePath, ".md")
  const fileOf = (path, text) => {
    const claims = fileClaims(text) ?? new Set()
    return {
      path,
      lines: new Set(text.split("\n").map((l) => l.trim())),
      claims,
      bytes: Buffer.byteLength(text),
      count: claims.size,
      added: new Map(),
      related: [],
    }
  }
  const files = listTexts(step, servicePath, { staged: false }).map(
    ({ path, n, text }) => ({ ...fileOf(path, text), n }),
  )
  if (!files.length) files.push({ ...fileOf(servicePath, ""), n: 1 })
  // The budgets of the list. The Service file keeps room for the claims of
  // the other skills; a part keeps a margin for the host fields.
  const limit = STEP_LIMITS.fileBytes
  const serviceForClaims = { bytes: limit - 8 * 1024, claims: 150 }
  const serviceForLines = { bytes: limit / 2, claims: Infinity }
  const part = { bytes: limit - 2048, claims: STEP_LIMITS.claims }
  const newPartBytes = 1024
  const room = (i, kind) =>
    i > 0 ? part : kind === "claim" ? serviceForClaims : serviceForLines
  /** The first file with room, else a new part. */
  const fileFor = (kind, bytes) => {
    const claims = kind === "claim" ? 1 : 0
    const at = files.findIndex(
      (file, i) =>
        file.bytes + bytes <= room(i, kind).bytes &&
        file.count + claims <= room(i, kind).claims,
    )
    if (at !== -1) return files[at]
    const n = Math.max(...files.map((file) => file.n)) + 1
    const next = fileOf(listPart(servicePath, n), "")
    files.push({ ...next, n, bytes: newPartBytes, count: 1, create: true })
    return files.at(-1)
  }
  const sorted = [...new Map(list.map((e) => [e.line, e])).values()].sort(
    (a, b) => (a.line < b.line ? -1 : 1),
  )
  for (const { claim } of sorted) {
    const key = `${claim.to} ${claim.predicate}`
    if (files.some((f) => f.claims.has(key) || f.added.has(key))) continue
    const file = fileFor("claim", claimBytes(claim))
    file.added.set(key, claim)
    file.bytes += claimBytes(claim)
    file.count++
  }
  for (const { line, claim } of sorted) {
    if (files.some((f) => f.lines.has(line))) continue
    const file = fileFor("line", Buffer.byteLength(line) + 1)
    file.lines.add(line)
    file.related.push(line)
    file.bytes += Buffer.byteLength(line) + 1
    file.evidence ??= claim.evidence.path
  }
  return files.flatMap((file, i) => {
    if (!file.related.length && !file.added.size) return []
    const claims = [...file.added.values()]
    if (i === 0)
      return [{ path: file.path, create: null, claims, related: file.related }]
    // The validator takes a name of at most 200 characters.
    const name = `${base.slice(0, 150)} dependencies ${file.n}`
    const evidence = claims[0]?.evidence.path ?? file.evidence
    return [
      {
        path: file.path,
        claims: file.create
          ? [
              {
                to: `${base}.md`,
                predicate: "PART_OF",
                evidence: { path: evidence, kind: "script" },
              },
              ...claims,
            ]
          : claims,
        related: file.related,
        expectName: name,
        exactName: true,
        create: {
          kind: "Service",
          name,
          summary: `Part ${file.n} of the dependency list of ${base}.`,
          intro: `This file continues the dependency list of [${base}](${base}.md). A script writes it when the list does not fit in one file.`,
        },
      },
    ]
  })
}
/**
 * The entries that an earlier run of this page staged and that are not at
 * the step base. writeStep writes each file from the base, so a later run
 * plans them again, also when resolutions.json no longer names them: each
 * run of a page writes at least what the runs before it wrote.
 */
function stagedEntries(servicePath) {
  const atBase = new Set(
    listTexts(step, servicePath, { staged: false }).flatMap((part) =>
      part.text.split("\n").map((l) => l.trim()),
    ),
  )
  return listTexts(step, servicePath)
    .flatMap((part) => part.text.split("\n").map((l) => l.trim()))
    .filter((line) => !atBase.has(line))
    .flatMap((line) => {
      const found = parseDependencyLine(line)
      return found?.repository === repository
        ? [
            {
              line,
              claim: {
                to: found.link,
                predicate: found.predicate,
                evidence: { path: found.file, kind: "model" },
              },
            },
          ]
        : []
    })
}
for (const root of rootsOfStep)
  for (const file of root.files.filter((f) => f.kind === "Service")) {
    const earlier = stagedEntries(file.path)
    if (earlier.length)
      entries.set(file.path, [...earlier, ...(entries.get(file.path) ?? [])])
  }
for (const [servicePath, list] of entries)
  plans.push(...listPlans(servicePath, list))

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
