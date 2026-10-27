#!/usr/bin/env node
// workflows: a repository-wide step on the assembled ref, after the other
// steps. It writes one knowledge/workflows/<owner>-<repository>-<file>.md file of
// kind Workflow for each GitHub Actions workflow file of the source
// (.github/workflows/*.yml and *.yaml). The file holds the triggers, the job
// ids, and a MENTIONS claim to each Service, App, or Library file of a root
// that an `on.<event>.paths` filter or a `working-directory` names. It never
// copies a `run`, `env`, `with`, or `secrets` value. A hash suffix keeps two
// names that collide apart. No model runs. A step
// writes at most 30 files; the host runs it again while the result has
// `more: true`.
//
// node workflows.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import { createHash } from "node:crypto"
import { posix } from "node:path"

import {
  DENIED_HEADINGS,
  INJECTION_PHRASES,
  WORKFLOW_FILE_PATTERN,
} from "../../bin/guard-patterns.mjs"
import {
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  readDeletes,
  writeDeletes,
} from "../../bin/stage-lib.mjs"
import {
  readTracked,
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { readWorkflow } from "./workflow-parse.mjs"

/**
 * A run reads at most this many workflow files, so that the files of one
 * repository take at most 50 of the 300 ops of a Workspace in a run.
 */
const MAX_WORKFLOWS = 50
/** The validator refuses a step that deletes more of the owned files. */
const DELETE_SHARE = 0.2
const MAX_STALE = 10
const MAX_LISTED = 50
const IN_SUMMARY = 5

const EVENT = /^[a-z][a-z0-9_]{0,63}$/
const JOB = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/
/** A workflow name that is safe as a heading and a YAML value. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.,()&+/-]{0,99}$/
const LOCATION = /^[A-Za-z0-9_./*?@[\]{},+-]{1,200}$/
const PACKAGE_KINDS = new Set(["Service", "App", "Library"])

const { step, source, repository, roots, index, skipped } = scriptStep()

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 8)

/**
 * True when the validator would refuse the text as an instruction to an
 * agent (ADR-052 section 5). It scans each text that the script writes, so
 * one such text would make it refuse the whole step. A hyphen in a job id
 * or a path can hold a phrase.
 */
const looksLikeInstruction = (text) =>
  INJECTION_PHRASES.some((pattern) => pattern.test(text))
const safeEvent = (text) => EVENT.test(text) && !looksLikeInstruction(text)
const safeJob = (text) => JOB.test(text) && !looksLikeInstruction(text)

/** The code root with the longest path that holds a location, or null. */
function rootOf(value) {
  let path = value.trim()
  while (path.startsWith("./")) path = path.slice(2)
  path = path.replace(/\/+$/, "")
  // A negation, an expression, or an absolute path names no root.
  if (!safePath(path) || !LOCATION.test(path) || path.startsWith("/"))
    return null
  let best = null
  for (const root of roots) {
    if (root.path === "." || looksLikeInstruction(root.path)) continue
    if (path !== root.path && !path.startsWith(`${root.path}/`)) continue
    if (!best || root.path.length > best.path.length) best = root
  }
  return best
}

const joinNames = (items) => {
  const shown = items.slice(0, IN_SUMMARY)
  const rest = items.length - shown.length
  const head = rest > 0 ? [...shown, `${rest} more`] : shown
  return head.length > 1
    ? `${head.slice(0, -1).join(", ")} and ${head.at(-1)}`
    : (head[0] ?? "")
}

// 1. The workflow files, and the context file of each one. Two files whose
//    names give the same path get a hash, in path order, and so does a file
//    whose path is the file of another source (`a-b/c` and `a/b-c`).
const found = trackedFiles(source)
  .filter(
    (p) =>
      p.startsWith(".github/workflows/") &&
      /\.ya?ml$/.test(p) &&
      !p.slice(".github/workflows/".length).includes("/"),
  )
  .sort()
const files = []
for (const path of found) {
  if (WORKFLOW_FILE_PATTERN.test(path) && looksLikeInstruction(path))
    skipped.push({
      path: null,
      reason: "The workflow file name has an instruction to an agent",
    })
  else if (WORKFLOW_FILE_PATTERN.test(path)) files.push(path)
  else
    skipped.push({
      path: safePath(path) ? path : null,
      reason:
        "The workflow file name has characters that the script does not quote",
    })
}
const entryAt = new Map(index.map((e) => [e.path, e]))
const otherSource = (path) => {
  const entry = entryAt.get(path)
  return entry?.owned === false && entry.sources?.length > 0
}
const targets = new Map()
const taken = new Set()
for (const file of files) {
  const stem = posix.basename(file).replace(/\.ya?ml$/, "")
  let name = slug(`${repository.replace("/", "-")}-${stem}`)
  if (name.length > 100)
    name = `${name.slice(0, 90).replace(/-+$/, "")}-${hash(file)}`
  let path = `knowledge/workflows/${name}.md`
  if (taken.has(path) || otherSource(path))
    path = `knowledge/workflows/${name}-${hash(`${repository}/${file}`)}.md`
  taken.add(path)
  targets.set(file, path)
}
if (files.length > MAX_WORKFLOWS)
  skipped.push({
    path: null,
    reason: `The script read only the first ${MAX_WORKFLOWS} of ${files.length} workflow files`,
  })

// 2. One plan for each workflow file that the script can read.
const isSoleOwned = (e) =>
  e?.owned === true && Array.isArray(e.sources) && e.sources.length === 1
const repositoryFile = findExisting(index, "Repository", [
  repository,
  repository.split("/").pop(),
])
const plans = []
for (const file of files.slice(0, MAX_WORKFLOWS)) {
  const path = targets.get(file)
  const entry = entryAt.get(path)
  if (entry && !isSoleOwned(entry) && entry.kind !== "Workflow") {
    skipped.push({ path, reason: "A file of another kind has this path" })
    continue
  }
  const workflow = readWorkflow(readTracked(source, file))
  if (workflow.skip) {
    skipped.push({ path: file, reason: workflow.skip })
    continue
  }
  const unsafe =
    workflow.triggers.filter((t) => !safeEvent(t)).length +
    workflow.jobs.filter((j) => !safeJob(j)).length
  if (unsafe)
    skipped.push({
      path: file,
      reason: `${unsafe} trigger or job names have characters that the script does not quote, or an instruction to an agent`,
    })
  const triggers = [...new Set(workflow.triggers.filter(safeEvent))]
  const jobs = workflow.jobs.filter(safeJob)
  const named = workflow.name?.trim() ?? ""
  // The validator refuses an instruction to an agent in the front matter
  // and in the body (ADR-052 section 5), so a name with such a phrase does
  // not stay in the file.
  const name =
    NAME.test(named) && !looksLikeInstruction(named)
      ? named
      : posix.basename(file)
  // The validator refuses a heading that addresses agents. Such a name stays
  // in `name` only: workflows such as `claude.yml` are common.
  const heading = DENIED_HEADINGS.some((pattern) => pattern.test(name))
    ? `GitHub Actions workflow ${hash(file)}`
    : name

  const claims = []
  const related = [
    repositoryFile
      ? `- Part of [${repository}](${relativeTo(path, repositoryFile)})`
      : `- Part of \`${repository}\``,
  ]
  for (const { where, event, job, value } of workflow.locations) {
    const root = rootOf(value)
    // `where` embeds an event key or a job key. Test the key as plainly as
    // the Triggers and Jobs lists do; a location with another key is out.
    if (
      !root ||
      (event !== undefined && !safeEvent(event)) ||
      (job !== undefined && !safeJob(job))
    )
      continue
    related.push(`- Names \`${root.path}\` in \`${where}\``)
    for (const target of root.files)
      if (PACKAGE_KINDS.has(target.kind))
        claims.push({
          to: relativeTo(path, target.path),
          predicate: "MENTIONS",
          evidence: { path: file, kind: "script" },
        })
  }

  let summary = `GitHub Actions workflow ${file} of ${repository}`
  if (triggers.length) summary += `, on ${joinNames(triggers)}`
  if (jobs.length) summary += `, with the jobs ${joinNames(jobs)}`
  summary = summary.length < 1000 ? `${summary}.` : `${summary.slice(0, 990)}.`
  const section = (title, items) =>
    items.length
      ? `## ${title}\n\n${items
          .slice(0, MAX_LISTED)
          .map((i) => `- \`${i}\``)
          .join("\n")}`
      : null
  plans.push({
    path,
    claims,
    related,
    replace: isSoleOwned(entry),
    create: {
      kind: "Workflow",
      name,
      heading,
      summary,
      intro: [
        `A script wrote this file from the GitHub Actions workflow \`${file}\` of \`${repository}\`. It holds the triggers, the job ids, and the code roots that the workflow names. It does not copy the steps of the workflow.`,
        section("Triggers", triggers),
        section("Jobs", jobs),
      ]
        .filter(Boolean)
        .join("\n\n"),
      fields: [["workflow_file", file]],
    },
  })
}

// 3. The files of this source whose workflow file has left the source. The
//    validator refuses a step that deletes more than 20% of the files that
//    the source owns alone, so the script deletes at most that many.
const known = new Set(targets.values())
const stale = index
  .filter(
    (e) =>
      e.kind === "Workflow" &&
      typeof e.path === "string" &&
      e.path.startsWith("knowledge/workflows/") &&
      isSoleOwned(e) &&
      !known.has(e.path),
  )
  .map((e) => e.path)
  .sort()
const limit = Math.min(
  MAX_STALE,
  Math.floor(
    index.filter((e) => e.path?.startsWith("knowledge/") && isSoleOwned(e))
      .length * DELETE_SHARE,
  ),
)
const deletes = readDeletes(step)
for (const path of stale.slice(0, limit)) {
  const blob = baseBlob(step, path)
  if (!blob) continue
  // The validator keeps a file with a human section; a human removes it.
  if (blobContent(step, blob).includes("<!-- ctxpipe:human -->"))
    skipped.push({
      path,
      reason: "The workflow file left the source; the file has a human section",
    })
  else
    deletes[path] = {
      baseBlob: blob,
      reason: "The workflow file left the source",
    }
}
for (const path of stale.slice(limit))
  skipped.push({
    path,
    reason: `The workflow file left the source; a step deletes at most ${limit} files`,
  })
if (Object.keys(deletes).length) writeDeletes(step, deletes)

writeStep(step, plans, skipped)
