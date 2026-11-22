#!/usr/bin/env node
// feature-gates: a repository-wide step on the assembled ref, after the root
// steps (CTX-1513). It finds the feature gates of the source (gates-lib.mjs)
// and writes one knowledge/features/<name>.md file of kind FeatureGate for
// each: its stage, its default, its owners, its KEP or tracking issue, and
// its description. Each file gets a PART_OF claim to the package unit of the
// deepest root that holds the declaring file, or else to the repository
// unit. A file that already describes the gate gets new claims and Related
// lines. No model runs. A step ends at the step limits of the host
// validator; the host runs it again while the result has `more: true`.
//
// node feature-gates.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import { execFileSync } from "node:child_process"
import { posix } from "node:path"

import {
  baseText,
  ownsWholeFile,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { EXTERNAL_URL } from "../../bin/purpose-lib.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { findGates, gateFile } from "./gates-lib.mjs"

const { step, source, sourcePath, repository, roots, index, skipped } =
  scriptStep()

const UNIT_KINDS = new Set(["Service", "App", "Library", "Repository"])
const STAGES = {
  alpha: "alpha",
  beta: "beta",
  ga: "GA",
  deprecated: "deprecated",
  unstable: "unstable",
  incomplete: "unstable (incomplete)",
  internal: "internal",
  accepted: "accepted (stable)",
  removed: "removed",
  stable_removed: "removed after it was stable",
}

const slug = (text) =>
  String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)

const stageOf = (stage) =>
  STAGES[String(stage).toLowerCase()] ?? (stage ? String(stage) : null)
const onOff = (value) => (value ? "on" : "off")

/** The paths under `folder` at the step base, in one git call. */
function basePaths(folder) {
  try {
    return new Set(
      execFileSync(
        "git",
        [
          "-C",
          step.contextDir,
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          step.baseCommit,
          "--",
          folder,
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

const ofSource = (entry) =>
  entry.owned === true ||
  (Array.isArray(entry.sources) &&
    entry.sources.some((s) => String(s).trim() === sourcePath))

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

/** The package unit files of the deepest root that holds `file`, or the repository unit. */
function unitsOf(file) {
  const holding = roots
    .filter((r) => r.path === "." || file.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)
  for (const root of holding) {
    const units = root.files.filter((f) => UNIT_KINDS.has(f.kind))
    if (units.length) return units.map((f) => f.path)
  }
  return codebase ? [codebase] : []
}

// The issue mirror (ADR-022, the GitHub mirror) keeps an issue at
// github/issues/<owner>/<repository>/<number>.md. A KEP number is the number
// of its issue in kubernetes/enhancements. A Rust tracking issue is an issue
// of the source repository.
const KEP_ISSUES = "github/issues/kubernetes/enhancements"
const ISSUES = `github/issues/${repository}`
const gates = findGates(source, trackedFiles(source).filter(gateFile), skipped)
const mirrored = gates.length
  ? new Set([...basePaths(KEP_ISSUES), ...basePaths(ISSUES)])
  : new Set()

/** A Decision file of the context that names KEP `n` in its name, or null. */
function kepDecision(n) {
  const named = new RegExp(`\\bKEP[- ]?${n}\\b`, "i")
  return (
    index
      .filter(
        (e) =>
          e?.kind === "Decision" &&
          typeof e.path === "string" &&
          safePath(e.path) &&
          typeof e.title === "string" &&
          named.test(e.title),
      )
      .map((e) => e.path)
      .sort()[0] ?? null
  )
}

/**
 * Source text as Markdown text: `<` and `>` escaped, and each URL outside
 * code in a code span. The host allows an external link only to a
 * repository of the Workspace, and a URL in code is not a link.
 */
function asText(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/[<>]/g, (c) => `\\${c}`)
            .replace(EXTERNAL_URL, (url) => `\`${url}\``),
    )
    .join("")
}

const taken = new Map()
const plans = []
const declared = new Map()
for (const gate of gates)
  declared.set(gate.name, (declared.get(gate.name) ?? 0) + 1)
for (const gate of gates) {
  const name = gate.name
  // A name that more than one file of the source declares gets a path by
  // its declaring folder, the same on each run, so that each gate keeps
  // its own file.
  const shared = declared.get(name) > 1
  // The file of this gate from an earlier run: a FeatureGate file of this
  // source with the name, whose Related line names the declaring file. When
  // one file of the source declares the name and one such file exists, it is
  // the file of the gate also when the declaring file changed (a Rust gate
  // moves from unstable.rs to accepted.rs or removed.rs).
  const declaredIn = `- Declared in \`${gate.file}\` of \`${repository}\``
  const named = index
    .filter(
      (e) =>
        e?.kind === "FeatureGate" &&
        typeof e.path === "string" &&
        safePath(e.path) &&
        e.title === name &&
        ofSource(e),
    )
    .map((e) => e.path)
    .sort()
  const existing =
    named.find((p) => (baseText(step, p) ?? "").includes(declaredIn)) ??
    (!shared && named.length === 1 ? named[0] : null)
  const candidates = [
    `knowledge/features/${slug(name)}.md`,
    `knowledge/features/${slug(repository.split("/")[1])}-${slug(name)}.md`,
  ]
  const path =
    existing ??
    (shared
      ? `knowledge/features/${slug(name)}-${slug(posix.dirname(gate.file))}.md`
      : (candidates.find(
          (c) => !taken.has(c) && !index.some((e) => e?.path === c),
        ) ?? null))
  if (!path || taken.has(path)) {
    skipped.push({
      path: gate.file,
      reason: `Another file has the path of the feature gate on line ${gate.line}`,
    })
    continue
  }
  taken.set(path, name)
  if (gate.descriptionCut)
    skipped.push({
      path: gate.file,
      reason: `The description of the feature gate on line ${gate.line} lost its last ${gate.descriptionCut} bytes at the 2 KiB limit`,
    })

  const link = (target, text) => `[${text}](${relativeTo(path, target)})`
  const facts = []
  const stage = stageOf(gate.stage)
  if (stage)
    facts.push(`- Stage: ${stage}${gate.since ? ` since ${gate.since}` : ""}`)
  if (gate.default !== null)
    facts.push(
      `- Default: ${onOff(gate.default)}${gate.locked ? ", locked to the default" : ""}`,
    )
  if (gate.owners.length)
    facts.push(`- Owners: ${gate.owners.map((o) => `\`${o}\``).join(", ")}`)
  for (const n of gate.keps) {
    const issue = `${KEP_ISSUES}/${n}.md`
    const decision = kepDecision(n)
    const refs = [
      ...(decision ? [link(decision, "decision")] : []),
      ...(mirrored.has(issue) ? [link(issue, "issue")] : []),
    ]
    facts.push(
      `- KEP: KEP-${n} (\`https://kep.k8s.io/${n}\`)${refs.length ? `, ${refs.join(", ")}` : ""}`,
    )
  }
  if (gate.issue !== null) {
    const issue = `${ISSUES}/${gate.issue}.md`
    facts.push(
      `- Tracking issue: ${mirrored.has(issue) ? link(issue, `#${gate.issue}`) : `#${gate.issue}`}`,
    )
  }
  const history = gate.history
    .filter((h) => h.version)
    .map(
      (h) =>
        `- ${h.version}: ${stageOf(h.stage)}, ${onOff(h.default)} by default${h.locked ? ", locked" : ""}`,
    )
  // The description is source text: it goes in a block quote with its source.
  const quote = gate.description
    ? [
        asText(gate.description)
          .split(/(?<=\.) /)
          .map((s) => `> ${s}`)
          .join("\n"),
        `Source: ${gate.file}`,
      ].join("\n\n")
    : null
  const kind =
    gate.convention === "rust"
      ? `a \`#![feature(${name})]\` gate`
      : "a feature gate"
  const summary = [
    `Feature gate ${name} of ${repository}`,
    stage ? `: ${stage}` : "",
    stage && gate.since ? ` since ${gate.since}` : "",
    gate.default !== null ? `, ${onOff(gate.default)} by default` : "",
    ".",
  ].join("")
  plans.push({
    path,
    expectName: name,
    exactName: true,
    claims: unitsOf(gate.file).map((unit) => ({
      to: relativeTo(path, unit),
      predicate: "PART_OF",
      evidence: { path: gate.file, kind: "script" },
    })),
    related: [`${declaredIn} (line ${gate.line})`],
    // The stage and the default of a gate change between releases: a file
    // that this source owns alone gets the current facts (CTX-1513).
    rewrite: ownsWholeFile(step, path, sourcePath),
    create: {
      kind: "FeatureGate",
      name,
      summary,
      intro: [
        `This is ${kind} of \`${repository}\`. A script found it in \`${gate.file}\`.`,
        ...(facts.length ? [facts.join("\n")] : []),
        ...(quote ? [quote] : []),
        ...(history.length ? [`### Stages\n\n${history.join("\n")}`] : []),
      ].join("\n\n"),
    },
  })
}

writeStep(step, plans, skipped)
