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
//   --source-url <url> --roots <root-to-file map> --path <root path> \
//   --resolutions /ctxpipe/out/resolutions.json

import { readFileSync, statSync } from "node:fs"
import { posix } from "node:path"
import {
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail } from "../../bin/stage-lib.mjs"
import { safePath } from "../../discover-roots/scripts/roots-lib.mjs"
import { scan } from "./scan-lib.mjs"

const MAX_RESOLUTIONS = 300
const MAX_STREAM_FILES = 28
const MAX_RESOLUTIONS_BYTES = 256 * 1024
const STREAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/

const argv = process.argv.slice(2)
const value = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? null : (argv[at + 1] ?? fail(`Give a value after ${name}`))
}
const path = value("--path") ?? fail("Give --path <root path>")
if (path !== "." && !safePath(path)) fail(`${path} is not a safe root path`)
const resolutionsFile =
  value("--resolutions") ?? fail("Give --resolutions <file>")

const { step, source, repository, roots, index, skipped } = scriptStep()
const current = roots.find((r) => r.path === path)
if (!current) fail(`${path} is not a root in the roots file`)
// Only a Service can DEPENDS_ON, CONSUMES_API, PRODUCES_TO, or CONSUMES_FROM.
const users = current.files.filter((f) => f.kind === "Service")

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
  resolutions = resolutions.slice(0, MAX_RESOLUTIONS)
}

const found = scan({
  source,
  path,
  otherRoots: roots.map((r) => r.path),
  index,
  own: new Set(current.files.map((f) => f.path)),
})
skipped.push(...found.skipped)
const byId = new Map(found.candidates.map((c) => [c.id, c]))
const entryAt = (p) => index.find((e) => e.path === p)

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const plans = []
const streams = new Set()
const skip = (id, reason) =>
  skipped.push({ path: null, reason: `${id}: ${reason}` })

if (!users.length && resolutions.length)
  skipped.push({
    path: null,
    reason: `The root ${path} has no Service file in the context, so it has no claims`,
  })
else
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== "object") continue
    const id =
      typeof resolution.id === "string" ? resolution.id.slice(0, 20) : "?"
    const candidate = byId.get(resolution?.id)
    if (!candidate) {
      skip(id, "no candidate has this id")
      continue
    }
    const kind = resolution.kind
    if (kind === "ignore") continue
    let target = null
    let predicate = null
    if (kind === "service" || kind === "api") {
      if (candidate.type === "queue" || candidate.type === "stream") {
        skip(id, "a queue or stream candidate needs a stream target")
        continue
      }
      const entry = entryAt(resolution.path)
      const kinds = kind === "service" ? ["Service"] : ["API", "Operation"]
      if (!entry || !kinds.includes(entry.kind)) {
        skip(
          id,
          `${String(resolution.path).slice(0, 100)} is not a ${kind} file of the context`,
        )
        continue
      }
      if (current.files.some((f) => f.path === entry.path)) {
        skip(id, "a root does not depend on itself")
        continue
      }
      target = { path: entry.path }
      predicate = kind === "service" ? "DEPENDS_ON" : "CONSUMES_API"
    } else if (kind === "stream") {
      if (candidate.type === "http") {
        skip(id, "an HTTP candidate needs a service or API target")
        continue
      }
      const direction =
        candidate.direction === "read"
          ? resolution.direction
          : candidate.direction
      if (direction !== "produce" && direction !== "consume") {
        skip(id, "give direction produce or consume for a config candidate")
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
        )
        continue
      }
      if (!streams.has(target.path) && streams.size >= MAX_STREAM_FILES) {
        skip(id, `the step writes at most ${MAX_STREAM_FILES} stream files`)
        continue
      }
      streams.add(target.path)
      const verb = direction === "produce" ? "produces to" : "consumes from"
      plans.push({
        path: target.path,
        claims: [],
        related: [
          `- \`${repository}\` ${verb} it in \`${path}\` (\`${candidate.file}\`)`,
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
      skip(id, "kind must be service, api, stream, or ignore")
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

writeStep(step, plans, skipped)
