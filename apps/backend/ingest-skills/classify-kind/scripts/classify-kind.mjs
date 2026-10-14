#!/usr/bin/env node
// classify-kind: a root step. It finds the kind of one code root (App,
// Service, or Library) with manifest and entrypoint rules, and writes one
// knowledge/{apps,services,libraries}/<name>.md file for it. A file that
// already describes the same package gets a new Related line, so a run adds
// no duplicate. When the rules cannot decide, the script writes nothing and
// lists the options; the model reads the listed files and runs the script
// again with --kind and --evidence.
//
// node classify-kind.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --path <root path> [--kind <kind> --evidence <file>]

import { existsSync, readFileSync } from "node:fs"
import { posix } from "node:path"
import {
  nameKey,
  relativeTo,
  repositoryName,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  currentStep,
  fail,
  parseArgs,
} from "../../bin/stage-lib.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { classifyRoot, decide, KINDS, modelFiles } from "./kind-rules.mjs"

const FOLDERS = { App: "apps", Library: "libraries", Service: "services" }
const LABELS = { App: "an app", Library: "a library", Service: "a service" }

const { root, args } = parseArgs()
const value = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? null : (args[at + 1] ?? fail(`Give a value after ${name}`))
}
const source = value("--source") ?? fail("Give --source <checkout>")
const sourceUrl = value("--source-url") ?? fail("Give --source-url <url>")
const rootPath = value("--path") ?? fail("Give --path <root path>")
const chosen = value("--kind")
const chosenEvidence = value("--evidence")
const repository = repositoryName(sourceUrl)
if (!repository) fail(`${sourceUrl} is not a repository URL`)
if (
  !safePath(rootPath) ||
  rootPath.startsWith("/") ||
  (rootPath !== "." && posix.normalize(rootPath) !== rootPath) ||
  rootPath.split("/").some((s) => s === "" || (s === "." && rootPath !== "."))
)
  fail("The root path has characters or segments that the script refuses")
if (chosenEvidence !== null && !chosen) fail("Give --kind with --evidence")

const step = currentStep(root)
const files = new Set(trackedFiles(source))
const dir = rootPath === "." ? "" : `${rootPath}/`
const result = {
  path: rootPath,
  name: null,
  kind: null,
  decidedBy: null,
  signals: [],
  ambiguous: null,
}

/** Write the step and print one JSON result. writeStep prints its own part; this script prints the whole result. */
function finish(plans, skipped = []) {
  const write = process.stdout.write
  process.stdout.write = () => true
  let written
  try {
    written = writeStep(step, plans, skipped)
  } finally {
    process.stdout.write = write
  }
  process.stdout.write(`${JSON.stringify({ ...result, ...written })}\n`)
  process.exit(0)
}

if (rootPath !== "." && ![...files].some((f) => f.startsWith(dir)))
  finish(
    [],
    [{ path: rootPath, reason: "The root is not a folder of the source" }],
  )

const { name: manifestName, signals } = classifyRoot(source, files, rootPath)
result.signals = signals
const folderName =
  rootPath === "." ? repository.split("/")[1] : posix.basename(rootPath)
const name =
  manifestName ??
  (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(folderName) ? folderName : null)
result.name = name

const decision = decide(signals)
let kind
let evidence
let reason
if (decision.kind) {
  if (chosen)
    fail(
      `The scripts decided the kind (${decision.kind}). Do not give --kind for this root.`,
    )
  kind = decision.kind
  // decide() uses the strong signals when there are any; the first one of the kind is the evidence.
  const first =
    signals.find((s) => s.kind === kind && s.strength === "strong") ??
    signals.find((s) => s.kind === kind)
  evidence = first.evidence
  reason = first.reason
  result.decidedBy = "script"
} else {
  const ambiguous = {
    reason: decision.reason,
    options: decision.options,
    files: modelFiles(files, rootPath),
  }
  if (!chosen) {
    result.ambiguous = ambiguous
    finish([])
  }
  if (!decision.options.includes(chosen))
    fail(`Choose one of: ${decision.options.join(", ")}`)
  evidence = chosenEvidence ?? ambiguous.files[0] ?? null
  if (
    !evidence ||
    !safePath(evidence) ||
    !evidence.startsWith(dir) ||
    !files.has(evidence)
  )
    fail(
      "Give --evidence <file>: a file of the source in the root that shows the kind",
    )
  kind = chosen
  reason = `the scripts could not decide (${decision.reason})`
  result.decidedBy = "model"
}
result.kind = kind

if (!name)
  finish(
    [],
    [
      {
        path: rootPath,
        reason: "The package has no name that the script can use",
      },
    ],
  )

const index = existsSync(step.indexFile)
  ? (JSON.parse(readFileSync(step.indexFile, "utf8")).entries ?? [])
  : []
const sameUrl = (url) =>
  String(url)
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "") ===
  sourceUrl
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
const ofSource = (entry) =>
  entry.owned === true ||
  (Array.isArray(entry.sources) && entry.sources.some(sameUrl))
const keys = new Set([nameKey(name), nameKey(folderName)].filter(Boolean))

// A file that already describes this package: same name, a root kind, and
// this source or no source (a file that a human wrote).
const existing = index
  .filter(
    (e) =>
      typeof e?.path === "string" &&
      safePath(e.path) &&
      KINDS.includes(e.kind) &&
      keys.has(nameKey(e.title)) &&
      (ofSource(e) || !e.sources?.length),
  )
  .sort(
    (a, b) =>
      Number(b.kind === kind) - Number(a.kind === kind) ||
      (a.path < b.path ? -1 : 1),
  )[0]

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
let path = existing?.path ?? null
if (!path) {
  const folder = `knowledge/${FOLDERS[kind]}`
  const candidates = [
    `${folder}/${slug(name)}.md`,
    `${folder}/${slug(repository.split("/")[1])}-${slug(name)}.md`,
  ].filter((candidate) => !candidate.endsWith("/.md"))
  // The index is from the run's pinned revision. A later step base can hold
  // the file that an earlier step of this run wrote for this package.
  path =
    candidates.find((candidate) => ownFile(candidate)) ??
    candidates.find((candidate) => !baseBlob(step, candidate))
  if (!path)
    finish(
      [],
      [{ path: rootPath, reason: "Another file has the path of this package" }],
    )
}

/** True when the base file at `candidate` has this package's name and this source. */
function ownFile(candidate) {
  const blob = baseBlob(step, candidate)
  if (!blob) return false
  const yaml =
    /^---[ \t]*\r?\n((?:.*\n)*?)---/.exec(
      blobContent(step, blob).toString("utf8"),
    )?.[1] ?? ""
  const line = yaml.split("\n").find((l) => l.startsWith("name:")) ?? ""
  const fileName = line
    .slice(5)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
  const listed = [...yaml.matchAll(/^\s*-\s+["']?([^"'\s]+)["']?\s*$/gm)].map(
    (m) => m[1],
  )
  return nameKey(fileName) === nameKey(name) && listed.some(sameUrl)
}

const codebase = index
  .filter(
    (e) =>
      e?.kind === "Repository" &&
      typeof e.path === "string" &&
      safePath(e.path) &&
      ofSource(e),
  )
  .map((e) => e.path)
  .sort()[0]
const where = rootPath === "." ? "the repository root" : `\`${rootPath}\``
const label = LABELS[kind]
finish([
  {
    path,
    claims: codebase
      ? [
          {
            to: relativeTo(path, codebase),
            predicate: "IMPLEMENTED_IN",
            evidence: { path: evidence, kind: result.decidedBy },
          },
        ]
      : [],
    related: [`- \`${repository}\` has it at ${where} (\`${evidence}\`)`],
    create: existing
      ? null
      : {
          kind,
          name,
          summary: `${label[0].toUpperCase()}${label.slice(1)} in the ${repository} repository.`,
          intro:
            result.decidedBy === "script"
              ? `A script classified it as ${label}: ${reason} (\`${evidence}\`).`
              : `The model classified it as ${label}, because ${reason}.`,
        },
  },
])
