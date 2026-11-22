#!/usr/bin/env node
// write-apis: turn the model's grouping of operations into APIs into the
// staged tree. The model writes a plan (data only). This script checks each
// operation against the evidence in the source repository, finds the context
// file that already describes the same API or operation, and writes the files
// with the shared writer (new files, and additive updates of existing ones).
//
// node write-apis.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> --path <root path> \
//   --plan /ctxpipe/home/apis-plan.json
//
// Plan: { "root": "apps/api", "service": "knowledge/services/api.md" | null,
//   "apis": [{ "name", "existing"?, "summary"?, "operations": [{ "method",
//   "path", "summary"?, "evidence"? }] }] }
//
// The cursor (CTX-1487): patch.json gets `cursor.at`, the candidate
// operations of `find-apis.mjs --count` that are done (`operationsDone`).

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"

import {
  fileClaims,
  findExisting,
  planText,
  relativeTo,
  stepArgs,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  currentStep,
  fail,
  STEP_LIMITS,
  stepTexts,
} from "../../bin/stage-lib.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import {
  apiLine as apiLineOf,
  candidateOperations,
  discoverApis,
  doneOperations,
  HTTP_METHODS,
  normalizePath,
  operationKey,
  plainText,
} from "./apis-lib.mjs"

const MAX_PLAN_BYTES = 256 * 1024
const API_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/
const METHOD_SET = new Set(HTTP_METHODS)

const args = stepArgs()
const { root, source, rootsFile, repository, sourcePath } = args
const planFile = args.value("--plan") ?? fail("Give --plan <plan file>")
const rootPath = args.rootPath ?? fail("Give --path <root path>")

const step = currentStep(root)
const skipped = []
const skip = (path, reason) => skipped.push({ path, reason })

if (!existsSync(planFile) || statSync(planFile).size > MAX_PLAN_BYTES)
  fail(`${planFile} is missing or larger than ${MAX_PLAN_BYTES} bytes`)
let plan
try {
  plan = JSON.parse(readFileSync(planFile, "utf8"))
} catch {
  fail(`${planFile} is not valid JSON`)
}
if (!plan || typeof plan !== "object" || !Array.isArray(plan.apis))
  fail(`${planFile} has no apis list`)
const codeRoot = plan.root
if (codeRoot !== "." && !safePath(codeRoot))
  fail("The plan root is not a safe path")
if (codeRoot !== rootPath)
  fail(`The plan root ${codeRoot} is not the step root ${rootPath}`)

const listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
const others = listed.map((r) => r?.path).filter((p) => typeof p === "string")

const index = existsSync(step.indexFile)
  ? (JSON.parse(readFileSync(step.indexFile, "utf8")).entries ?? [])
  : []
const entryByPath = new Map(index.map((entry) => [entry.path, entry]))
const tracked = new Set(trackedFiles(source))
const candidates = candidateOperations(discoverApis(source, codeRoot, others))

const baseText = (path) => {
  const blob = baseBlob(step, path)
  return blob ? blobContent(step, blob).toString("utf8") : null
}
const sameTitle = (entry, name) =>
  typeof entry?.title === "string" &&
  entry.title.trim().toLowerCase() === name.toLowerCase()
const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 8)
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

// --- the service file ---------------------------------------------------------

let service = null
if (plan.service !== undefined && plan.service !== null) {
  const entry = entryByPath.get(plan.service)
  if (!entry || entry.kind !== "Service")
    skip(
      safePath(plan.service) ? plan.service : null,
      "The service is not a file of kind Service in the context index",
    )
  else if (
    !(entry.sources ?? []).some((path) => String(path).trim() === sourcePath)
  )
    skip(plan.service, "The service file does not list this source")
  else service = plan.service
}

// --- resolve each API and its operations ----------------------------------------

function resolveOperation(api, input) {
  const method =
    typeof input?.method === "string" ? input.method.toUpperCase() : ""
  const path = normalizePath(input?.path)
  if (!METHOD_SET.has(method) || !path) {
    skip(
      null,
      `An operation of ${api.name} has no HTTP method or no plain path`,
    )
    return null
  }
  const key = operationKey(method, path)
  const script = candidates.get(key)
  let evidence
  if (script) evidence = { path: script.evidence, kind: "script" }
  else if (
    typeof input.evidence === "string" &&
    safePath(input.evidence) &&
    tracked.has(input.evidence)
  )
    evidence = { path: input.evidence, kind: "model" }
  else {
    skip(
      null,
      `${key} has no evidence: it is not in a specification or a route that the script found, and it names no source file`,
    )
    return null
  }
  let summary = plainText(input.summary, 200)
  if (input.summary !== undefined && !summary) {
    skip(null, `The summary of ${key} has text that the script does not write`)
  }
  summary ??= plainText(script?.summary, 200)
  return {
    key,
    name: key,
    method,
    path,
    evidence,
    summary: summary ?? `HTTP operation ${key}.`,
  }
}

const resolved = []
const seenApiPaths = new Set()
for (const input of plan.apis) {
  const name = typeof input?.name === "string" ? input.name.trim() : ""
  if (!API_NAME.test(name) || !slug(name)) {
    skip(null, "An API name has characters that the script does not write")
    continue
  }
  const api = { name, operations: [] }
  let existing = null
  if (input.existing !== undefined && input.existing !== null) {
    const entry = entryByPath.get(input.existing)
    if (entry?.kind === "API") existing = entry.path
    else
      skip(
        null,
        `${name}: existing is not a file of kind API in the context index`,
      )
  }
  existing ??= findExisting(index, "API", [name])
  api.path = existing ?? `knowledge/apis/${slug(name)}.md`
  api.entry = entryByPath.get(api.path) ?? null
  api.exists = baseBlob(step, api.path) !== null
  if (!existing && api.exists) {
    // A file at the path that the index does not list: its name is unknown.
    skip(api.path, `${name}: another file has the path of the new API`)
    continue
  }
  if (seenApiPaths.has(api.path)) {
    skip(api.path, `${name}: another API of the plan resolves to the same file`)
    continue
  }
  seenApiPaths.add(api.path)
  api.summary =
    plainText(input.summary, 300) ??
    `${name}: HTTP API that a source repository exposes.`
  if (input.summary !== undefined && !plainText(input.summary, 300))
    skip(null, `The summary of ${name} has text that the script does not write`)
  const operations = Array.isArray(input.operations) ? input.operations : []
  const seen = new Set()
  for (const operation of operations) {
    const op = resolveOperation(api, operation)
    if (!op || seen.has(op.key)) continue
    seen.add(op.key)
    api.operations.push(op)
  }
  if (api.operations.length === 0) {
    skip(
      api.path,
      `${name} has no operation with evidence: the script wrote no file for it`,
    )
    continue
  }
  resolved.push(api)
}

/** The file of an operation: an existing one (linked from the existing API, or at the new path), or a new path. */
const usedOperationPaths = new Map()
for (const api of resolved) {
  const linked = (api.entry?.links ?? [])
    .map((path) => entryByPath.get(path))
    .filter((entry) => entry?.kind === "Operation")
  const apiSlug = slug(api.name)
  for (const op of api.operations) {
    const reuse = linked.find((entry) => sameTitle(entry, op.name))
    let path = reuse?.path ?? null
    if (!path) {
      const tail = slug(op.path.slice(1)) || "root"
      const base = `knowledge/operations/${apiSlug}-${op.method.toLowerCase()}-${tail}`
      const options = [
        base.length > 100 ? `${base.slice(0, 90)}-${hash(op.key)}` : base,
        `${base.slice(0, 90)}-${hash(`${api.path} ${op.key}`)}`,
      ].map((name) => `${name}.md`)
      for (const option of options) {
        const taken = usedOperationPaths.get(option)
        const at = baseBlob(step, option) !== null
        const ours = sameTitle(entryByPath.get(option), op.name)
        if ((taken && taken !== `${api.path} ${op.key}`) || (at && !ours))
          continue
        path = option
        break
      }
    }
    if (!path) {
      skip(null, `${op.key}: no free file name in knowledge/operations`)
      op.drop = true
      continue
    }
    usedOperationPaths.set(path, `${api.path} ${op.key}`)
    op.file = path
    op.exists = baseBlob(step, path) !== null
  }
  api.operations = api.operations.filter((op) => !op.drop)
}

// --- the related lines, and what is left to write ----------------------------

const specLine = (path) => `- \`${repository}\` defines it in \`${path}\``
const apiLine = apiLineOf(repository, codeRoot)
const opLine = (op) => specLine(op.evidence.path)

for (const api of resolved) {
  for (const op of api.operations) {
    const text = op.exists ? baseText(op.file) : null
    op.pending = !op.exists || !text?.includes(opLine(op))
  }
  const text = api.exists ? baseText(api.path) : null
  // A page can end after the operations and before their API file or the
  // Service file (writeStep writes a claim target first). The next page then
  // writes the claims that are missing.
  const claims = text === null ? null : fileClaims(text)
  const serviceText = service ? baseText(service) : null
  const serviceClaims = serviceText === null ? null : fileClaims(serviceText)
  api.pending =
    !api.exists ||
    !text?.includes(apiLine) ||
    api.operations.some((op) => op.pending) ||
    api.operations.some(
      (op) =>
        claims?.has(`${relativeTo(api.path, op.file)} HAS_OPERATION`) === false,
    ) ||
    (api.operations.length > 0 &&
      serviceClaims?.has(`${relativeTo(service, api.path)} EXPOSES_API`) ===
        false)
}

/** The plan of the API file of an API. */
const apiPlan = (api) => ({
  path: api.path,
  expectName: api.exists ? undefined : api.name,
  exactName: true,
  create: {
    kind: "API",
    name: api.name,
    summary: api.summary,
    intro: api.summary,
  },
  related: [
    apiLine,
    ...new Set(api.operations.map((op) => specLine(op.evidence.path))),
  ],
  claims: api.operations.map((op) => ({
    to: relativeTo(api.path, op.file),
    predicate: "HAS_OPERATION",
    evidence: op.evidence,
  })),
})

// An API file that the validator would refuse for its size or its claim
// count gets no file, and its operations get none: no API file would link
// them (CTX-1487).
const selected = resolved.filter((api) => {
  if (!api.pending) return false
  if (planText(step, apiPlan(api)).tooLarge) {
    skip(
      api.path,
      `${api.name}: the API file would be larger than ${STEP_LIMITS.fileBytes / 1024} KiB or have more than ${STEP_LIMITS.claims} operations. Split the API into smaller APIs, for example by path prefix`,
    )
    return false
  }
  return true
})

// --- plans for the shared writer ------------------------------------------------

const plans = []
for (const api of selected) {
  plans.push(apiPlan(api))
  for (const op of api.operations)
    plans.push({
      path: op.file,
      expectName: op.name,
      exactName: true,
      create: {
        kind: "Operation",
        name: op.name,
        summary: op.summary,
        intro: `${op.summary} Method \`${op.method}\`, path \`${op.path}\`.`,
      },
      claims: [],
      related: [opLine(op)],
    })
  if (service && api.operations.length > 0)
    plans.push({
      path: service,
      create: null,
      related: [],
      claims: [
        {
          to: relativeTo(service, api.path),
          predicate: "EXPOSES_API",
          evidence: api.operations[0].evidence,
        },
      ],
    })
}

// The API files of this root from earlier pages: an earlier page can end
// before the Service file, and a new plan holds only the operations that
// wait. So the script adds each EXPOSES_API claim that the Service file
// does not have, with a source file of the API file as evidence.
if (service) {
  const serviceClaims =
    fileClaims(stepTexts(step, [service]).get(service) ?? "") ?? new Set()
  const scriptPaths = new Set([...candidates.values()].map((c) => c.evidence))
  for (const file of doneOperations(step, { repository, codeRoot, candidates })
    .apiFiles) {
    const to = relativeTo(service, file.path)
    const prefix = specLine("").slice(0, -1)
    const evidence = file.text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix) && l.endsWith("`"))
      ?.slice(prefix.length, -1)
    if (serviceClaims.has(`${to} EXPOSES_API`) || !evidence) continue
    plans.push({
      path: service,
      create: null,
      related: [],
      claims: [
        {
          to,
          predicate: "EXPOSES_API",
          evidence: {
            path: evidence,
            kind: scriptPaths.has(evidence) ? "script" : "model",
          },
        },
      ],
    })
  }
}

/**
 * The cursor (CTX-1487): the candidate operations of the root that are done
 * (`doneOperations`). writeStep writes an Operation file before its API
 * file, so a page that ends between them has not done the candidate yet.
 *
 * The Service file of the plan comes after all API files. While it does not
 * have the EXPOSES_API claim to each API file of the root, the last
 * candidate is not done: a page that ends before the Service file does not
 * reach the end of the input.
 */
function operationsDone() {
  const { done, apiFiles } = doneOperations(step, {
    repository,
    codeRoot,
    candidates,
  })
  let at = done.size
  if (service) {
    const claims =
      fileClaims(stepTexts(step, [service]).get(service) ?? "") ?? new Set()
    if (
      apiFiles.some(
        (file) => !claims.has(`${relativeTo(service, file.path)} EXPOSES_API`),
      )
    )
      at = Math.min(at, Math.max(0, candidates.size - 1))
  }
  return at
}

writeStep(step, plans, skipped, { cursorAt: operationsDone })
