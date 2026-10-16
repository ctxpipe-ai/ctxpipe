import { posix } from "node:path"
import { isDeepStrictEqual } from "node:util"

/**
 * Instruction-area files (concept section 5, ADR-052 section 4). An area file
 * is shared: more than one source repository adds evidence to it. This module
 * reads the strict body format and checks the shared-file rules of the patch
 * validator. The skill script `instruction-areas/scripts/areas-lib.mjs` writes
 * the same format; a test runs both on the same files.
 *
 * Body format (each rule is one bullet, its facts are two-space sub-bullets):
 *
 *   # <title>
 *   ## Summary          one paragraph
 *   ## Rules            - <rule text>
 *                         - topic: `<key>` = `<value>` (core)
 *                         - source `<url>`, documented: `<path>`, ...
 *                         - source `<url>`, inferred from `<pattern>`: `<path>`, ...
 *   ## Repository notes - `<url>`: <text>
 *   ## Being replaced   rules, in the same form as Rules
 */

export type AreaEvidence = {
  basis: "documented" | "inferred"
  paths: string[]
  /** The literal text that each evidence file of an inferred rule holds. */
  pattern?: string
}

export type AreaRule = {
  section: "rules" | "replaced"
  key: string
  value: string
  core: boolean
  text: string
  sources: Map<string, AreaEvidence>
}

export type AreaNote = { source: string; text: string }

export type AreaFile = {
  title: string
  summary: string
  rules: AreaRule[]
  notes: AreaNote[]
}

const MAX_RULES = 60
const MAX_NOTES = 100
const MAX_EVIDENCE_PATHS = 20
const MIN_NEW_AREA_RULES = 5
const MIN_INFERRED_FILES = 3
const MIN_INFERRED_DIRECTORIES = 2

const SECTION_ORDER = [
  "Summary",
  "Rules",
  "Repository notes",
  "Being replaced",
] as const

const TOPIC =
  /^ {2}- topic: `([a-z0-9][a-z0-9-]{0,59})` = `([^`\n]{1,100})`( \(core\))?$/
const SOURCE =
  /^ {2}- source `([^`\s]{1,300})`, (documented|inferred(?: from `([^`\n]{3,200})`)?): (`[^`\n]{1,300}`(?:, `[^`\n]{1,300}`)*)$/
const NOTE = /^- `([^`\s]{1,300})`: (\S.{0,299})$/
const RULE = /^- (\S.{0,299})$/

/** The area file body (after the front matter, human blocks removed) as data, or a reason. */
export function parseAreaBody(
  body: string,
  normalize: (url: string) => string,
): AreaFile | { error: string } {
  if (body.includes("\r")) return { error: "The body has a carriage return" }
  const lines = body.split("\n")
  let at = 0
  while (at < lines.length && lines[at]?.trim() === "") at++
  const title = /^# (\S.{0,199})$/.exec(lines[at] ?? "")?.[1]
  if (!title) return { error: "The body must start with a '# <title>' line" }
  at++

  const sections = new Map<string, string[]>()
  let current: string | null = null
  let lastOrder = -1
  for (; at < lines.length; at++) {
    const line = lines[at] ?? ""
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      const name = /^## (.+?)\s*$/.exec(line)?.[1]
      const order = SECTION_ORDER.findIndex((s) => s === name)
      if (!name || order === -1 || order <= lastOrder)
        return {
          error:
            "The sections are Summary, Rules, Repository notes, and Being replaced, once each, in this order",
        }
      lastOrder = order
      current = name
      sections.set(name, [])
      continue
    }
    if (current === null) {
      if (line.trim() !== "")
        return { error: "Text before the first section is not allowed" }
      continue
    }
    sections.get(current)?.push(line)
  }
  const summary = (sections.get("Summary") ?? []).join("\n").trim()
  if (!summary || summary.length > 2000)
    return { error: "The Summary section needs 1 to 2000 characters" }
  if (!sections.has("Rules")) return { error: "The Rules section is missing" }

  const rules: AreaRule[] = []
  const keys = new Set<string>()
  for (const [name, section] of [
    ["Rules", "rules"],
    ["Being replaced", "replaced"],
  ] as const) {
    let rule: AreaRule | null = null
    let topics = 0
    const close = (): string | null => {
      if (!rule) return null
      if (topics !== 1) return "A rule needs exactly one topic line"
      if (rule.sources.size === 0)
        return "A rule needs at least one source line"
      return null
    }
    for (const line of sections.get(name) ?? []) {
      if (line.trim() === "") continue
      const start = RULE.exec(line)
      if (start) {
        const problem = close()
        if (problem) return { error: problem }
        rule = {
          section,
          key: "",
          value: "",
          core: false,
          text: start[1] ?? "",
          sources: new Map(),
        }
        topics = 0
        rules.push(rule)
        continue
      }
      if (!rule) return { error: `A line in ${name} is not a rule` }
      const topic = TOPIC.exec(line)
      if (topic) {
        topics++
        rule.key = topic[1] ?? ""
        rule.value = topic[2] ?? ""
        rule.core = Boolean(topic[3])
        if (keys.has(rule.key))
          return { error: "Two rules have the same topic key" }
        keys.add(rule.key)
        continue
      }
      const source = SOURCE.exec(line)
      if (source) {
        const url = normalize(source[1] ?? "")
        const paths = [...(source[4] ?? "").matchAll(/`([^`\n]+)`/g)].map(
          (m) => m[1] ?? "",
        )
        if (rule.sources.has(url))
          return { error: "A rule has two source lines for one source" }
        if (paths.length > MAX_EVIDENCE_PATHS)
          return {
            error: `A source line names more than ${MAX_EVIDENCE_PATHS} paths`,
          }
        if (paths.some((p) => !relativePath(p)))
          return { error: "An evidence path is not a relative source path" }
        const pattern = source[3]
        rule.sources.set(
          url,
          source[2] === "documented"
            ? { basis: "documented", paths }
            : { basis: "inferred", paths, ...(pattern ? { pattern } : {}) },
        )
        continue
      }
      return { error: `A line in ${name} does not match the rule format` }
    }
    const problem = close()
    if (problem) return { error: problem }
  }
  if (rules.length > MAX_RULES)
    return { error: `An area file has at most ${MAX_RULES} rules` }

  const notes: AreaNote[] = []
  for (const line of sections.get("Repository notes") ?? []) {
    if (line.trim() === "") continue
    const note = NOTE.exec(line)
    if (!note)
      return { error: "A repository note does not match the note format" }
    notes.push({ source: normalize(note[1] ?? ""), text: note[2] ?? "" })
  }
  if (notes.length > MAX_NOTES)
    return { error: `An area file has at most ${MAX_NOTES} notes` }
  return { title, summary, rules, notes }
}

/**
 * The area body (no human blocks) without the evidence lines and notes of
 * `source`. A rule that has no other source line goes too. Each other line
 * stays as it is. `source` is a normalized URL.
 */
export function withoutAreaSource(
  body: string,
  source: string,
  normalize: (url: string) => string,
): string {
  const out: string[] = []
  // The lines of the open rule; a rule with no source line left goes.
  let rule: string[] = []
  let ruleSources = 0
  const flush = () => {
    if (ruleSources > 0) out.push(...rule)
    rule = []
    ruleSources = 0
  }
  let section: string | null = null
  for (const line of body.split("\n")) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      section = heading[1] ?? null
      out.push(line)
      continue
    }
    if (section === "Rules" || section === "Being replaced") {
      if (RULE.test(line)) {
        flush()
        rule.push(line)
        continue
      }
      if (rule.length > 0 && line.startsWith("  - ")) {
        const evidence = SOURCE.exec(line)
        if (evidence) {
          if (normalize(evidence[1] ?? "") === source) continue
          ruleSources++
        }
        rule.push(line)
        continue
      }
      flush()
      out.push(line)
      continue
    }
    if (section === "Repository notes") {
      const note = NOTE.exec(line)
      if (note && normalize(note[1] ?? "") === source) continue
    }
    out.push(line)
  }
  flush()
  return out.join("\n")
}

function relativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((s) => s === "" || s === "." || s === "..")
  )
}

export type AreaChange =
  | { error: string }
  | {
      /** `sources` of the result file. */
      sources: string[]
      /** Evidence paths that this source added or changed: the host checks that they exist. */
      freshEvidence: string[]
      /** Inferred evidence that this source added or changed: the host checks that each file holds the pattern. */
      freshPatterns: Array<{ pattern: string; paths: string[] }>
    }

/**
 * Shared-file rules (concept section 5.3). `before` is null for a new file.
 * `source` and `beforeSources` are normalized URLs.
 *
 * With other sources in the file, the update:
 * - keeps the title and the summary;
 * - changes only the evidence lines and notes of its own source, and the
 *   rules that it adds;
 * - keeps each rule that has evidence from another source, in its section,
 *   with the same text, topic, and evidence of the other sources.
 * A source that is alone can change its file freely, in the format.
 */
export function checkAreaChange(input: {
  before: AreaFile | null
  after: AreaFile
  source: string
  beforeSources: readonly string[]
}): AreaChange {
  const { before, after, source, beforeSources } = input
  const others = beforeSources.filter((s) => s !== source)
  const shared = others.length > 0
  if (shared && !before)
    return {
      error: "The existing area file has a form that the check does not read",
    }
  const known = new Set([...beforeSources, source])

  for (const rule of after.rules)
    for (const url of rule.sources.keys())
      if (!known.has(url))
        return {
          error:
            "A rule has evidence from a source that the file does not list",
        }
  for (const note of after.notes)
    if (!known.has(note.source))
      return { error: "A note names a source that the file does not list" }

  if (before && shared) {
    if (before.title !== after.title || before.summary !== after.summary)
      return {
        error:
          "Only the source that owns the file alone can change the title and summary",
      }
    const afterRules = new Map(after.rules.map((r) => [r.key, r]))
    const beforeRules = new Map(before.rules.map((r) => [r.key, r]))
    for (const rule of before.rules) {
      const kept = [...rule.sources].filter(([url]) => url !== source)
      if (kept.length === 0) continue
      const next = afterRules.get(rule.key)
      if (
        !next ||
        next.section !== rule.section ||
        next.text !== rule.text ||
        next.value !== rule.value ||
        next.core !== rule.core
      )
        return {
          error:
            "A rule with evidence from another source must stay as it is, in its section",
        }
      for (const [url, evidence] of kept)
        if (!isDeepStrictEqual(next.sources.get(url), evidence))
          return { error: "The evidence of another source must stay as it is" }
    }
    for (const rule of after.rules) {
      const old = beforeRules.get(rule.key)
      for (const [url, evidence] of rule.sources) {
        if (url === source) continue
        if (!isDeepStrictEqual(old?.sources.get(url), evidence))
          return { error: "Only the source itself can add its evidence" }
      }
    }
    const foreign = (notes: AreaNote[]) =>
      notes.filter((n) => n.source !== source)
    if (!isDeepStrictEqual(foreign(before.notes), foreign(after.notes)))
      return { error: "The notes of another source must stay as they are" }
  }

  const beforeEvidence = new Map<string, AreaEvidence>()
  for (const rule of before?.rules ?? []) {
    const own = rule.sources.get(source)
    if (own) beforeEvidence.set(rule.key, own)
  }
  const fresh: string[] = []
  const freshPatterns: Array<{ pattern: string; paths: string[] }> = []
  let hasOwn = after.notes.some((n) => n.source === source)
  for (const rule of after.rules) {
    const own = rule.sources.get(source)
    if (!own) continue
    hasOwn = true
    if (isDeepStrictEqual(beforeEvidence.get(rule.key), own)) continue
    if (own.basis === "inferred") {
      const files = new Set(own.paths)
      if (own.pattern === undefined)
        return { error: "A rule that a script inferred needs its pattern" }
      if (files.size < MIN_INFERRED_FILES)
        return {
          error: `A rule that a script inferred needs evidence in at least ${MIN_INFERRED_FILES} files`,
        }
      if (
        new Set([...files].map((p) => posix.dirname(p))).size <
        MIN_INFERRED_DIRECTORIES
      )
        return {
          error: `A rule that a script inferred needs evidence in at least ${MIN_INFERRED_DIRECTORIES} folders`,
        }
      freshPatterns.push({ pattern: own.pattern, paths: [...files] })
    }
    fresh.push(...own.paths)
  }

  const sources = new Set(beforeSources)
  if (hasOwn) sources.add(source)
  else sources.delete(source)
  if (sources.size === 0)
    return { error: "Delete the file when the last source leaves" }
  if (!beforeSources.includes(source) && !hasOwn)
    return { error: "The update has no evidence of this source" }

  if (!before) {
    const count = after.rules.filter((r) => r.section === "rules").length
    if (count < MIN_NEW_AREA_RULES)
      return {
        error: `A new area file needs at least ${MIN_NEW_AREA_RULES} rules`,
      }
  }
  return {
    sources: [...sources].sort(),
    freshEvidence: [...new Set(fresh)],
    freshPatterns,
  }
}
