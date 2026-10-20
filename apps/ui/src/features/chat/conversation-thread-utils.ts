import type { ChatMessage } from "./types"

export type ToolBucket = "read" | "search" | "tool"

export type ToolCallSummary = {
  bucket: ToolBucket
  /** What the call does, for example "Read file". */
  action: string
  /** The main argument, for example the file path; null when the call has none. */
  detail: string | null
}

type ToolBucketCounts = {
  reads: number
  searches: number
  tools: number
}

const READ_TOOLS = new Set(["read", "get_file"])
const SEARCH_TOOLS = new Set([
  "glob",
  "glob_files",
  "grep",
  "hybrid_search",
  "search",
  "find_symbol_definitions",
  "find_symbol_references",
  "structural_search",
  "graph_find_symbol",
])

const DETAIL_KEYS = [
  "filePath",
  "path",
  "file",
  "pattern",
  "glob",
  "query",
  "q",
  "symbol",
  "command",
] as const

const JOIN_KEYS = ["globs", "paths"] as const
const DETAIL_MAX = 72

export function toolBucket(name: string): ToolBucket {
  const normalized = name.trim() || "tool"
  if (READ_TOOLS.has(normalized)) return "read"
  if (SEARCH_TOOLS.has(normalized)) return "search"
  return "tool"
}

export function toolCallAction(name: string, bucket: ToolBucket): string {
  if (name === "bash") return "Run command"
  if (name === "edit") return "Edit file"
  if (name === "write") return "Write file"
  if (bucket === "read") return "Read file"
  if (bucket === "search") return "Search"
  const words = name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Used tool"
}

function truncateDetail(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= DETAIL_MAX) return trimmed
  return `${trimmed.slice(0, DETAIL_MAX - 1)}…`
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim()
  return null
}

function joinedStrings(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : null
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw?.trim()) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export function toolCallDetail(part: {
  input?: unknown
  arguments?: string
}): string | null {
  const input =
    part.input && typeof part.input === "object"
      ? part.input
      : parseArguments(part.arguments)
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    for (const key of DETAIL_KEYS) {
      const value = firstString(record[key])
      if (value) return truncateDetail(value)
    }
    for (const key of JOIN_KEYS) {
      const value = joinedStrings(record[key])
      if (value) return truncateDetail(value)
    }
  }
  return null
}

export function toolBucketCounts(tools: ToolCallSummary[]): ToolBucketCounts {
  let reads = 0
  let searches = 0
  let other = 0
  for (const tool of tools) {
    if (tool.bucket === "read") reads += 1
    else if (tool.bucket === "search") searches += 1
    else other += 1
  }
  return { reads, searches, tools: other }
}

export type ActivityChipKind = ToolBucket | "thought"

export function activityChips(
  counts: ToolBucketCounts & { thoughts: number },
): Array<{ kind: ActivityChipKind; label: string }> {
  const chips: Array<{ kind: ActivityChipKind; label: string }> = []
  if (counts.reads > 0) {
    chips.push({
      kind: "read",
      label: counts.reads === 1 ? "Read 1 file" : `Read ${counts.reads} files`,
    })
  }
  if (counts.searches > 0) {
    chips.push({
      kind: "search",
      label: counts.searches === 1 ? "1 search" : `${counts.searches} searches`,
    })
  }
  if (counts.tools > 0) {
    chips.push({
      kind: "tool",
      label: counts.tools === 1 ? "Used 1 tool" : `Used ${counts.tools} tools`,
    })
  }
  if (counts.thoughts > 0) {
    chips.push({
      kind: "thought",
      label:
        counts.thoughts === 1 ? "1 thought" : `${counts.thoughts} thoughts`,
    })
  }
  return chips
}

const BOLD_HEADING_LINE = /^\s*\*\*([^*]+)\*\*\s*$/
const ATX_HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/

function reasoningHeadingTitle(line: string): string | null {
  const bold = line.match(BOLD_HEADING_LINE)
  if (bold?.[1]?.trim()) return bold[1].trim()
  const atx = line.match(ATX_HEADING_LINE)
  if (atx?.[1]?.trim()) return atx[1].trim()
  return null
}

export type Thought = {
  /** The heading, or the first line when the block has no heading. */
  title: string
  /** True when the title is a heading of the text, not a copy of its first line. */
  hasHeading: boolean
  body: string
}

const TITLE_MAX = 80

function shortTitle(line: string): string {
  const plain = line
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (plain.length <= TITLE_MAX) return plain
  return `${plain.slice(0, TITLE_MAX - 1)}…`
}

/**
 * Splits one reasoning text into thoughts, one for each heading. Models write
 * a bold or ATX heading at the start of each thought, sometimes glued to the
 * end of the previous sentence. Text before the first heading belongs to the
 * first thought.
 */
export function splitThoughts(text: string): Thought[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/([.!?])(\*\*[^*\n]+\*\*)[ \t]*(?=\n|$)/g, "$1\n$2")
    .split("\n")
  const intro: string[] = []
  const sections: Array<{ heading: string; lines: string[] }> = []
  for (const line of lines) {
    const heading = reasoningHeadingTitle(line)
    const current = sections.at(-1)
    if (heading) sections.push({ heading, lines: [] })
    else if (current) current.lines.push(line)
    else intro.push(line)
  }
  const introText = intro.join("\n").trim()
  const first = sections[0]
  if (!first) {
    const firstLine = introText.split("\n")[0] ?? ""
    return introText
      ? [{ title: shortTitle(firstLine), hasHeading: false, body: introText }]
      : []
  }
  return sections.map((section) => {
    const body = section.lines.join("\n").trim()
    return {
      title: shortTitle(section.heading),
      hasHeading: true,
      body:
        section === first && introText
          ? [introText, body].filter(Boolean).join("\n\n")
          : body,
    }
  })
}

export type ActivityEntry =
  | { kind: "thought"; key: string; thought: Thought }
  | { kind: "tool"; key: string; tool: ToolCallSummary }

/** The turn's thoughts and tool calls in the order the agent made them. */
export function activityLog(parts: ChatMessage["parts"]): ActivityEntry[] {
  const seen = new Set<string>()
  const entries: ActivityEntry[] = []
  parts.forEach((part, partIndex) => {
    if (part.type === "thinking") {
      splitThoughts(part.content ?? part.text ?? "").forEach(
        (thought, index) => {
          entries.push({
            kind: "thought",
            key: `thought-${partIndex}-${index}`,
            thought,
          })
        },
      )
      return
    }
    if (part.type !== "tool-call") return
    const name = part.name?.trim() || "tool"
    const id = part.id?.trim() || `${name}-${partIndex}`
    if (seen.has(id)) return
    seen.add(id)
    const bucket = toolBucket(name)
    entries.push({
      kind: "tool",
      key: `tool-${id}`,
      tool: {
        bucket,
        action: toolCallAction(name, bucket),
        detail: toolCallDetail(part),
      },
    })
  })
  return entries
}

/**
 * A hydrated turn arrives as several assistant messages, one per engine
 * segment, all with the turn's id. Render them as one message so tools,
 * thoughts, and the reply group as they did live.
 */
export function groupAssistantTurns(messages: ChatMessage[]): ChatMessage[] {
  const turns: ChatMessage[] = []
  for (const message of messages) {
    const previous = turns.at(-1)
    if (message.role === "assistant" && previous?.role === "assistant") {
      turns[turns.length - 1] = {
        ...previous,
        parts: [...previous.parts, ...message.parts],
      }
      continue
    }
    turns.push(message)
  }
  return turns
}
