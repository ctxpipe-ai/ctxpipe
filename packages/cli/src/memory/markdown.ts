/**
 * Tiny YAML-frontmatter parser/serializer for ctxpipe memory records.
 *
 * We deliberately avoid pulling in a full YAML dependency: the canonical
 * memory record only uses a small, well-defined subset of YAML keys (`id`,
 * `type`, `concepts`, `files`, plus ISO 8601 timestamps and a couple of
 * optional bookkeeping fields). The parser refuses any frontmatter shape
 * outside that subset so we never silently lose data.
 */

export type MemoryRecordType =
  | "architecture"
  | "decision"
  | "pattern"
  | "lesson"
  | "session"
  | "fact"
  | "note"

export type MemoryRecord = {
  id: string
  type: MemoryRecordType | string
  title: string
  body: string
  concepts: string[]
  files: string[]
  createdAt: string
  updatedAt: string
  /** Other frontmatter keys we preserve on round-trip but don't interpret. */
  extra: Record<string, string | string[]>
}

export class MarkdownParseError extends Error {
  constructor(
    message: string,
    public readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message)
    this.name = "MarkdownParseError"
  }
}

const FRONTMATTER_FENCE = /^---\s*\n/
const FRONTMATTER_END = /\n---\s*(\n|$)/
const MERGE_CONFLICT_MARKER = /^(<{7}|={7}|>{7}) /m

const KNOWN_KEYS = new Set([
  "id",
  "type",
  "concepts",
  "files",
  "createdAt",
  "updatedAt",
])

/** Read a Markdown record from a string. */
export function parseRecord(source: string, file?: string): MemoryRecord {
  if (MERGE_CONFLICT_MARKER.test(source)) {
    throw new MarkdownParseError(
      "unresolved merge conflict markers present",
      file,
    )
  }
  if (!FRONTMATTER_FENCE.test(source)) {
    throw new MarkdownParseError("missing YAML frontmatter (--- block)", file)
  }
  const afterOpen = source.replace(FRONTMATTER_FENCE, "")
  const endMatch = afterOpen.match(FRONTMATTER_END)
  if (!endMatch || endMatch.index === undefined) {
    throw new MarkdownParseError("frontmatter is not terminated by ---", file)
  }
  const frontmatter = afterOpen.slice(0, endMatch.index)
  const body = afterOpen.slice(endMatch.index + endMatch[0].length)

  const fm = parseFrontmatter(frontmatter, file)

  const id = mustString(fm, "id", file)
  const type = mustString(fm, "type", file)
  const createdAt = mustString(fm, "createdAt", file)
  const updatedAt = mustString(fm, "updatedAt", file)
  const concepts = asList(fm.concepts) ?? []
  const files = asList(fm.files) ?? []

  const trimmedBody = body.replace(/^\n+/, "")
  const title = extractTitle(trimmedBody) ?? id

  const extra: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(fm)) {
    if (KNOWN_KEYS.has(key)) continue
    extra[key] = value
  }

  return {
    id,
    type,
    title,
    body: trimmedBody.replace(/\n+$/, "\n").trimEnd(),
    concepts,
    files,
    createdAt,
    updatedAt,
    extra,
  }
}

export function serializeRecord(record: MemoryRecord): string {
  const lines: string[] = ["---"]
  lines.push(`id: ${record.id}`)
  lines.push(`type: ${record.type}`)
  lines.push(`concepts: ${formatList(record.concepts)}`)
  if (record.files.length > 0) {
    lines.push(`files:`)
    for (const file of record.files) {
      lines.push(`  - ${file}`)
    }
  } else {
    lines.push(`files: []`)
  }
  lines.push(`createdAt: ${record.createdAt}`)
  lines.push(`updatedAt: ${record.updatedAt}`)
  for (const [key, value] of Object.entries(record.extra)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) {
          lines.push(`  - ${item}`)
        }
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push("---")
  lines.push("")
  if (!record.body.startsWith("#")) {
    lines.push(`# ${record.title}`)
    lines.push("")
  }
  lines.push(record.body)
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}

function parseFrontmatter(
  src: string,
  file: string | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const lines = src.split(/\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    i += 1
    if (line.trim().length === 0) continue
    if (line.startsWith("#")) continue
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!match) {
      throw new MarkdownParseError(`unrecognized frontmatter line: ${line}`, file)
    }
    const key = match[1] ?? ""
    const rawValue = (match[2] ?? "").trim()
    if (rawValue.length === 0) {
      // Block list: collect indented `- value` lines until a non-list line.
      const items: string[] = []
      while (i < lines.length) {
        const candidate = lines[i] ?? ""
        if (/^\s+-\s/.test(candidate)) {
          items.push(candidate.replace(/^\s+-\s/, "").trim())
          i += 1
          continue
        }
        if (candidate.trim().length === 0) {
          i += 1
          continue
        }
        break
      }
      out[key] = items
      continue
    }
    if (rawValue === "[]") {
      out[key] = []
      continue
    }
    // Inline flow list: [a, b, c]
    const flowMatch = rawValue.match(/^\[(.*)\]$/)
    if (flowMatch) {
      const inner = flowMatch[1] ?? ""
      out[key] = inner.length === 0
        ? []
        : inner.split(",").map((item) => item.trim()).filter(Boolean)
      continue
    }
    out[key] = stripQuotes(rawValue)
  }
  return out
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function asList(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null
  return Array.isArray(value) ? value : []
}

function mustString(
  fm: Record<string, string | string[]>,
  key: string,
  file: string | undefined,
): string {
  const value = fm[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new MarkdownParseError(`frontmatter field \`${key}\` is required`, file)
  }
  return value
}

function extractTitle(body: string): string | null {
  const match = body.match(/^#\s+(.+)/)
  return match ? (match[1] ?? null) : null
}

function formatList(items: string[]): string {
  if (items.length === 0) return "[]"
  return `[${items.join(", ")}]`
}
