// Area files of the instruction-areas skill (concept section 5, ADR-052
// section 4): the seed list, the file format, and the same-or-different
// comparison. The host validator (apps/backend/src/domain/ingestion/
// area-file.ts) reads the same format; a test runs both on one file.
//
// Format (a rule is one bullet; its facts are two-space sub-bullets):
//   # <title>
//   ## Summary          one paragraph
//   ## Rules            - <rule text>
//                         - topic: `<key>` = `<value>` (core)
//                         - source `<url>`, documented: `<path>`, ...
//                         - source `<url>`, inferred from `<pattern>`: `<path>`, ...
//   ## Repository notes - `<url>`: <text>
//   ## Being replaced   rules, in the same form as Rules

/** About 20 area slugs. A new area outside this list needs the same five rules. */
export const SEED_AREAS = [
  ["unit-testing", "Unit testing"],
  ["integration-testing", "Integration testing"],
  ["end-to-end-testing", "End-to-end testing"],
  ["code-style", "Code style"],
  ["naming-conventions", "Naming conventions"],
  ["error-handling", "Error handling"],
  ["logging", "Logging"],
  ["observability", "Observability"],
  ["api-design", "API design"],
  ["database-migrations", "Database migrations"],
  ["dependency-management", "Dependency management"],
  ["type-safety", "Type safety"],
  ["configuration", "Configuration"],
  ["security", "Security"],
  ["git-workflow", "Git workflow"],
  ["commit-messages", "Commit messages"],
  ["code-review", "Code review"],
  ["documentation", "Documentation"],
  ["ci-cd", "CI and CD"],
  ["frontend-components", "Frontend components"],
]

export const SEED_SLUGS = new Set(SEED_AREAS.map(([slug]) => slug))
export const MIN_NEW_AREA_RULES = 5
export const MAX_AREAS = 15
export const MAX_RULES = 60
/** An area file of another source agrees at this share, or more, when no core rule conflicts. */
export const SAME_SHARE = 0.7
/** Below this share of agreeing rules, the practice is significantly different. */
export const DIFFERENT_SHARE = 0.5

const HUMAN_OPEN = "<!-- ctxpipe:human -->"
const HUMAN_CLOSE = "<!-- /ctxpipe:human -->"
const TOPIC =
  /^ {2}- topic: `([a-z0-9][a-z0-9-]{0,59})` = `([^`\n]{1,100})`( \(core\))?$/
const SOURCE =
  /^ {2}- source `([^`\s]{1,300})`, (documented|inferred(?: from `([^`\n]{3,200})`)?): (`[^`\n]{1,300}`(?:, `[^`\n]{1,300}`)*)$/
const NOTE = /^- `([^`\s]{1,300})`: (\S.{0,299})$/
const RULE = /^- (\S.{0,299})$/
const SECTIONS = ["Summary", "Rules", "Repository notes", "Being replaced"]

/** Same text rule as the host: no control or direction character. */
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check refuses control and direction characters
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/

/**
 * One line of text from the model that is safe in the area format, or null:
 * no control character, no backtick (the script changes it to a quote), no
 * markup that starts a block, at most `max` characters.
 */
export function cleanText(text, max) {
  if (typeof text !== "string" || UNSAFE.test(text)) return null
  const line = text.replace(/`/g, "'").replace(/\s+/g, " ").trim()
  if (
    !line ||
    line.length > max ||
    /^[-#>|*+=\d]/.test(line) ||
    /[<>]/.test(line)
  )
    return null
  return line
}

/**
 * The normal form of a source in an area file: the source file path of the
 * Workspace (ADR-050 revision 2026-10-16), trimmed, as the host reads it.
 */
export function normalizeSource(url) {
  return String(url).trim()
}

export function nameKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

export const slugify = (text, max = 30) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "")

function frontMatter(text) {
  const match = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)
  return match
    ? { raw: match[0], yaml: match[1], body: text.slice(match[0].length) }
    : null
}

/** The `sources` list of a front matter block, normalized. */
export function frontSources(yaml) {
  const lines = yaml.split("\n")
  const at = lines.findIndex((l) => l.startsWith("sources:"))
  if (at === -1) return []
  const unquote = (t) => t.trim().replace(/^(["'])(.*)\1$/, "$2")
  const rest = lines[at].slice("sources:".length).trim()
  if (rest.startsWith("["))
    return rest
      .slice(1, rest.lastIndexOf("]"))
      .split(",")
      .map(unquote)
      .map(normalizeSource)
  const items = []
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (!item) break
    items.push(normalizeSource(unquote(item[1])))
  }
  return items
}

/** True when the front matter has `generated_by: ctxpipe-extract`. */
function generatedByHost(yaml) {
  return yaml
    .split("\n")
    .some((l) => /^generated_by:\s*["']?ctxpipe-extract["']?\s*$/.test(l))
}

/**
 * Read a whole area file. Returns { front, sources, area, human } or
 * { error }. `human` holds each human block as written; it never changes.
 */
export function parseAreaFile(text) {
  if (text.includes("\r")) return { error: "The file has a carriage return" }
  const front = frontMatter(text)
  if (!front) return { error: "The file has no front matter" }
  if (!generatedByHost(front.yaml))
    return { error: "The file is not generated" }
  const human = []
  const body = front.body.replace(
    new RegExp(`${HUMAN_OPEN}[\\s\\S]*?${HUMAN_CLOSE}`, "g"),
    (block) => {
      human.push(block)
      return ""
    },
  )
  if (body.includes(HUMAN_OPEN) || body.includes(HUMAN_CLOSE))
    return { error: "The human markers are not in pairs" }
  const area = parseAreaBody(body)
  if (area.error) return { error: area.error }
  return { front: front.raw, sources: frontSources(front.yaml), area, human }
}

function parseAreaBody(body) {
  const lines = body.split("\n")
  let at = 0
  while (at < lines.length && lines[at].trim() === "") at++
  const title = /^# (\S.{0,199})$/.exec(lines[at] ?? "")?.[1]
  if (!title) return { error: "The body must start with a title line" }
  const sections = new Map()
  let current = null
  let last = -1
  for (at++; at < lines.length; at++) {
    const line = lines[at]
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      const name = /^## (.+?)\s*$/.exec(line)?.[1]
      const order = SECTIONS.indexOf(name)
      if (!name || order === -1 || order <= last)
        return { error: "The sections are not in the area format" }
      last = order
      current = name
      sections.set(name, [])
    } else if (current === null) {
      if (line.trim() !== "") return { error: "Text before the first section" }
    } else sections.get(current).push(line)
  }
  const summary = (sections.get("Summary") ?? []).join("\n").trim()
  if (!summary || !sections.has("Rules"))
    return { error: "Summary or Rules is missing" }
  const rules = []
  for (const [name, section] of [
    ["Rules", "rules"],
    ["Being replaced", "replaced"],
  ]) {
    let rule = null
    for (const line of sections.get(name) ?? []) {
      if (line.trim() === "") continue
      const start = RULE.exec(line)
      if (start) {
        rule = {
          section,
          key: "",
          value: "",
          core: false,
          text: start[1],
          sources: new Map(),
        }
        rules.push(rule)
        continue
      }
      if (!rule) return { error: "A line is not a rule" }
      const topic = TOPIC.exec(line)
      if (topic) {
        Object.assign(rule, {
          key: topic[1],
          value: topic[2],
          core: Boolean(topic[3]),
        })
        continue
      }
      const source = SOURCE.exec(line)
      if (source) {
        const paths = [...source[4].matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
        rule.sources.set(
          normalizeSource(source[1]),
          source[2] === "documented"
            ? { basis: "documented", paths }
            : {
                basis: "inferred",
                paths,
                ...(source[3] ? { pattern: source[3] } : {}),
              },
        )
        continue
      }
      return { error: "A line does not match the rule format" }
    }
  }
  if (rules.some((r) => !r.key || r.sources.size === 0))
    return { error: "A rule has no topic or no source" }
  const notes = []
  for (const line of sections.get("Repository notes") ?? []) {
    if (line.trim() === "") continue
    const note = NOTE.exec(line)
    if (!note) return { error: "A note does not match the note format" }
    notes.push({ source: normalizeSource(note[1]), text: note[2] })
  }
  return { title, summary, rules, notes }
}

function ruleLines(rule) {
  return [
    `- ${rule.text}`,
    `  - topic: \`${rule.key}\` = \`${rule.value}\`${rule.core ? " (core)" : ""}`,
    ...[...rule.sources].map(
      ([url, e]) =>
        `  - source \`${url}\`, ${e.basis}${e.pattern === undefined ? "" : ` from \`${e.pattern}\``}: ${e.paths.map((p) => `\`${p}\``).join(", ")}`,
    ),
  ].join("\n")
}

/** The text of an area file: front matter text, the area, and the human blocks. */
export function renderAreaFile(front, area, human = []) {
  const parts = [
    `# ${area.title}`,
    `## Summary\n\n${area.summary}`,
    `## Rules\n\n${area.rules
      .filter((r) => r.section === "rules")
      .map(ruleLines)
      .join("\n\n")}`,
  ]
  if (area.notes.length)
    parts.push(
      `## Repository notes\n\n${area.notes.map((n) => `- \`${n.source}\`: ${n.text}`).join("\n")}`,
    )
  const replaced = area.rules.filter((r) => r.section === "replaced")
  if (replaced.length)
    parts.push(`## Being replaced\n\n${replaced.map(ruleLines).join("\n\n")}`)
  const tail = human.length ? `\n${human.join("\n\n")}\n` : ""
  return `${front}\n${parts.join("\n\n")}\n${tail}`
}

/** Front matter text of a new area file. */
export function newFront(name, summary) {
  return `---\nkind: InstructionUnit\nname: ${JSON.stringify(name)}\nsummary: ${JSON.stringify(summary)}\n---\n`
}

/**
 * Compare the candidate rules of a source (the Rules section only) with the
 * rules of an area file that carry evidence of other sources (concept 5.2).
 *
 * - conflict: same topic key, another value, and one of the two is core;
 * - agree: same topic key and value;
 * - different: a core conflict, or less than DIFFERENT_SHARE agree;
 * - same: no core conflict and at least SAME_SHARE agree;
 * - between: the rest. The source joins; its small differences become notes.
 */
export function compareRules(candidates, fileRules) {
  const byKey = new Map(fileRules.map((r) => [r.key, r]))
  let agree = 0
  const conflicts = []
  const differing = []
  for (const c of candidates) {
    const known = byKey.get(c.key)
    if (!known) continue
    if (nameKey(known.value) === nameKey(c.value)) agree++
    else if (known.core || c.core) conflicts.push(c)
    else differing.push(c)
  }
  const total = candidates.length
  const share = total === 0 ? 0 : agree / total
  let decision = "between"
  if (conflicts.length > 0 || share < DIFFERENT_SHARE) decision = "different"
  else if (share >= SAME_SHARE) decision = "same"
  return { decision, agree, total, share, conflicts, differing }
}
