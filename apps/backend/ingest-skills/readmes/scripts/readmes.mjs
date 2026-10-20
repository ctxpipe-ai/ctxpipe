#!/usr/bin/env node
// readmes: a repository-wide step on the assembled ref, after the other
// steps. For each root with a README, it quotes the first text of the
// README into an `## Overview` section of the root's package file, and it
// replaces the stub summary of that file. The README at the top of the
// repository goes to the repository unit when no root is the repository top.
// It changes only a file that this source owns alone. A README that changes
// gives a new section on the next run; a root with no README keeps its file.
// No model runs. A step writes at most 30 files; the host runs it again
// while the result has `more: true`.
//
// node readmes.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import { posix } from "node:path"
import {
  baseText,
  frontBlock,
  frontList,
  frontMatter,
  frontValue,
  scriptStep,
  stubSummary,
  writeEdits,
  yamlScalar,
} from "../../bin/knowledge-lib.mjs"
import {
  isReadme,
  readTracked,
  safePath,
  trackedSizes,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { quoteSummary, readmeOverview } from "./readme-quote.mjs"

const PACKAGE_KINDS = new Set(["Service", "App", "Library"])
const OVERVIEW = /^##[ \t]+overview[ \t#]*$/i
const SOURCE_LINE = /^Source: `([^`\s]+)`$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HUMAN_OPEN = "<!-- ctxpipe:human -->"
const HUMAN_CLOSE = "<!-- /ctxpipe:human -->"

const { step, source, sourcePath, repository, roots, index, skipped } =
  scriptStep()

// The README of each folder, from the tracked regular files: README.md
// first, then the first other name in path order.
const readmes = new Map()
for (const { path } of trackedSizes(source)) {
  if (!isReadme(path)) continue
  const dir = posix.dirname(path)
  const known = readmes.get(dir)
  const better = posix.basename(path) === "README.md" || path < known
  if (!known || (posix.basename(known) !== "README.md" && better))
    readmes.set(dir, path)
}

const ownSource = (entry) =>
  Array.isArray(entry?.sources) &&
  entry.sources.some((s) => String(s).trim() === sourcePath)
const indexed = index
  .filter(
    (e) => typeof e?.path === "string" && safePath(e.path) && ownSource(e),
  )
  .sort((a, b) => (a.path < b.path ? -1 : 1))

// The package file of each root: the file of this source whose host `root`
// is the root. A root whose steps changed nothing in this run still has it.
const byRoot = new Map()
for (const entry of indexed.filter((e) => PACKAGE_KINDS.has(e.kind))) {
  const yaml = frontMatter(baseText(step, entry.path) ?? "")
  const at = yaml && frontValue(yaml, "root")
  if (at && !byRoot.has(at)) byRoot.set(at, entry.path)
}

const targets = new Map()
for (const root of roots) {
  const readme = readmes.get(root.path)
  const target = byRoot.get(root.path)
  if (readme && target && !targets.has(target)) targets.set(target, readme)
}
const top = readmes.get(".")
const unit = indexed.find((e) => e.kind === "Repository")?.path
if (top && unit && !roots.some((r) => r.path === ".") && !targets.has(unit))
  targets.set(unit, top)

/**
 * The structure of a body: each heading of level 1 or 2 and each start of a
 * human section, as line numbers. Lines in fenced code and in a human
 * section are not read.
 */
function outline(lines) {
  const marks = []
  let fence = null
  let human = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (human) {
      if (line.includes(HUMAN_CLOSE)) human = false
      continue
    }
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null
    } else if (marker) fence = marker
    else if (line.includes(HUMAN_OPEN)) {
      marks.push({ at: i, human: true })
      human = !line.slice(line.indexOf(HUMAN_OPEN)).includes(HUMAN_CLOSE)
    } else {
      const heading = /^ {0,3}(#{1,2})[ \t]/.exec(line)
      if (heading) marks.push({ at: i, level: heading[1].length, line })
    }
  }
  return marks
}

/**
 * The `## Overview` section as line numbers, or null. It ends at the next
 * heading of level 1 or 2, or at a human section.
 */
function overviewSection(marks, length) {
  const at = marks.findIndex((m) => m.level === 2 && OVERVIEW.test(m.line))
  if (at === -1) return null
  return { start: marks[at].at, end: marks[at + 1]?.at ?? length }
}

/** Front matter with a new summary, or null when its form is not one line. */
function withSummary(yaml, summary) {
  const lines = yaml.replace(/\n$/, "").split("\n")
  const line = `summary: ${JSON.stringify(summary)}`
  const at = lines.findIndex((l) => l.startsWith("summary:"))
  if (at === -1)
    lines.splice(lines.findIndex((l) => l.startsWith("name:")) + 1, 0, line)
  else if (/^[ \t-]/.test(lines[at + 1] ?? "")) return null
  else lines[at] = line
  return `${lines.join("\n")}\n`
}

function edit(before, readme) {
  if (before === null) return { skip: "The file is not in the context" }
  const front = frontBlock(before)
  if (!front) return { skip: "The file has no front matter" }
  let yaml = front.yaml
  const sources = frontList(yaml, "sources")
  if (
    frontValue(yaml, "generated_by") !== "ctxpipe-extract" ||
    sources.length !== 1 ||
    sources[0] !== sourcePath
  )
    return { skip: "The source does not own the file alone" }
  if (!safePath(readme) || /[\s`]/.test(readme))
    return {
      skip: "The README path has characters that the script does not quote",
    }
  const overview = readmeOverview(readTracked(source, readme), readme)
  if (!overview) return { skip: "The README has no text that the skill quotes" }

  const lines = before.slice(front.length).split("\n")
  const marks = outline(lines)
  const section = overviewSection(marks, lines.length)
  const old = section ? lines.slice(section.start, section.end) : []
  const ours = old.some((l) => isReadme(SOURCE_LINE.exec(l)?.[1] ?? ""))
  if (section && !ours)
    return {
      skip: "The file has an Overview section that the skill did not write",
    }
  const start =
    section?.start ?? marks.find((m) => m.level === 2)?.at ?? lines.length
  const end = section?.end ?? start
  const head = lines.slice(0, start).join("\n").trimEnd()
  const tail = lines.slice(end).join("\n").replace(/^\n+/, "")
  const block = `## Overview\n\n${overview.quote}\n`
  const body = `${head ? `${head}\n\n` : ""}${block}${tail ? `\n${tail}` : ""}`

  // Replace a summary only when it is absent, when it is the stub, or when
  // it is the summary of the old quote, which the skill wrote. A summary
  // that a person changed, or that the script cannot read, stays.
  const summaryLine = yaml.split("\n").find((l) => l.startsWith("summary:"))
  const summary = summaryLine ? yamlScalar(summaryLine.slice(8)) : null
  const replaceable =
    summaryLine === undefined ||
    (summary !== null &&
      (summary === stubSummary(frontValue(yaml, "kind"), repository) ||
        (ours && summary === quoteSummary(old.slice(1)))))
  if (overview.summary && summary !== overview.summary && replaceable)
    yaml = withSummary(yaml, overview.summary) ?? yaml
  return `---\n${yaml}---\n${body}`
}

writeEdits(
  step,
  [...targets].map(([path, readme]) => ({
    path,
    edit: (before) => edit(before, readme),
  })),
  skipped,
)
