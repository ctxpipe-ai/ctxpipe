#!/usr/bin/env node
// readmes: a repository-wide step on the assembled ref, after the other
// steps. For each root with a README, it quotes the opening text of the
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

import { execFileSync } from "node:child_process"
import { posix } from "node:path"
import {
  baseText,
  frontList,
  frontMatter,
  frontValue,
  scriptStep,
  writeEdits,
} from "../../bin/knowledge-lib.mjs"
import {
  readTracked,
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { readmeOverview } from "./readme-quote.mjs"

const PACKAGE_KINDS = new Set(["Service", "App", "Library"])
const README = /^readme(?:\.(?:md|markdown))?$/i
/** The summaries that classify-kind and repository write. */
const STUB =
  /^(?:(?:A service|An app|A library) in the \S+ repository|The source repository \S+)\.$/
const OVERVIEW = /^##[ \t]+overview[ \t#]*$/i
const SOURCE_LINE = /^Source: `([^`\s]+)`$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HUMAN_OPEN = "<!-- ctxpipe:human -->"
const HUMAN_CLOSE = "<!-- /ctxpipe:human -->"

const { step, source, sourceUrl, sourcePath, roots, index, skipped } =
  scriptStep()

// The README of each folder: README.md first, then other names in order.
const readmes = new Map()
const rank = (path) => [posix.basename(path) === "README.md" ? 0 : 1, path]
for (const path of trackedFiles(source)) {
  if (!README.test(posix.basename(path))) continue
  const dir = posix.dirname(path)
  const known = readmes.get(dir)
  const [a, b] = [rank(path), known ? rank(known) : null]
  if (!b || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]))
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

// A root whose steps changed nothing in this run has no file in the map:
// the host `root` of a package file of this source finds it.
let byRoot = null
function packageFileAt(root) {
  if (!byRoot) {
    byRoot = new Map()
    for (const entry of indexed.filter((e) => PACKAGE_KINDS.has(e.kind))) {
      const yaml = frontMatter(baseText(step, entry.path) ?? "")
      const at = yaml && frontValue(yaml, "root")
      if (at && !byRoot.has(at)) byRoot.set(at, entry.path)
    }
  }
  return byRoot.get(root) ?? null
}

const targets = new Map()
for (const root of roots) {
  const readme = readmes.get(root.path)
  if (!readme) continue
  const target =
    root.files.find((f) => PACKAGE_KINDS.has(f.kind))?.path ??
    packageFileAt(root.path)
  if (target && !targets.has(target)) targets.set(target, readme)
}
const top = readmes.get(".")
const unit = indexed.find((e) => e.kind === "Repository")?.path
if (top && unit && !roots.some((r) => r.path === ".") && !targets.has(unit))
  targets.set(unit, top)

// Only a regular file is read: a symbolic link has the target as its text.
const regular = new Set()
if (targets.size)
  for (const entry of execFileSync(
    "git",
    ["-C", source, "ls-files", "-s", "-z", "--", ...new Set(targets.values())],
    { maxBuffer: 16 * 1024 * 1024 },
  )
    .toString("utf8")
    .split("\0")) {
    const [meta, path] = entry.split("\t")
    if (path && /^100(?:644|755) /.test(meta)) regular.add(path)
  }

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

/** A YAML scalar on one line, decoded; null when the script cannot read it. */
function scalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (text.startsWith("'"))
    return /^'((?:[^']|'')*)'$/.exec(text)?.[1].replaceAll("''", "'") ?? null
  return /^[|>]/.test(text) ? null : text
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
  const front = /^---[ \t]*\n((?:.*\n)*?)---[ \t]*(?:\n|$)/.exec(before)
  if (!front) return { skip: "The file has no front matter" }
  let yaml = front[1]
  const sources = frontList(yaml, "sources")
  if (
    frontValue(yaml, "generated_by") !== "ctxpipe-extract" ||
    sources.length !== 1 ||
    sources[0] !== sourcePath
  )
    return { skip: "The source does not own the file alone" }
  if (!regular.has(readme) || !safePath(readme) || /[\s`]/.test(readme))
    return { skip: "The README is not a regular file with a safe path" }
  const overview = readmeOverview(readTracked(source, readme), {
    readmePath: readme,
    sourceUrl,
  })
  if (!overview) return { skip: "The README has no text that the skill quotes" }

  const lines = before.slice(front[0].length).split("\n")
  const marks = outline(lines)
  const section = overviewSection(marks, lines.length)
  const old = section ? lines.slice(section.start, section.end) : []
  const ours = old.some((l) =>
    README.test(posix.basename(SOURCE_LINE.exec(l)?.[1] ?? "")),
  )
  if (section && !ours)
    return {
      skip: "The file has an Overview section that the skill did not write",
    }
  const start =
    section?.start ?? marks.find((m) => m.level === 2)?.at ?? lines.length
  const end = section?.end ?? start
  const head = lines.slice(0, start).join("\n").trimEnd()
  const tail = lines.slice(end).join("\n").replace(/^\n+/, "")
  const block = `## Overview\n\n${overview.quote}\n\nSource: \`${readme}\`\n`
  const body = `${head ? `${head}\n\n` : ""}${block}${tail ? `\n${tail}` : ""}`

  const summaryLine = yaml.split("\n").find((l) => l.startsWith("summary:"))
  const summary = summaryLine ? scalar(summaryLine.slice(8)) : null
  if (
    overview.summary &&
    summary !== overview.summary &&
    (summary === null || STUB.test(summary) || ours)
  )
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
