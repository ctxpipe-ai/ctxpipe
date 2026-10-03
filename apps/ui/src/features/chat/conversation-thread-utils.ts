export type ToolBucket = "read" | "search" | "tool"

export type ToolCallSummary = {
  id: string
  name: string
  bucket: ToolBucket
  detail: string
}

export type ToolBucketCounts = {
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

export function toolCallFallbackLabel(name: string): string {
  if (name === "bash") return "Run command"
  if (name === "edit") return "Edit file"
  if (name === "write") return "Write file"
  const bucket = toolBucket(name)
  if (bucket === "read") return "Read file"
  if (bucket === "search") return "Search files"
  return "Used tool"
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
  name?: string
  input?: unknown
  arguments?: string
}): string {
  const name = part.name?.trim() || "tool"
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
  return toolCallFallbackLabel(name)
}

export function summarizeToolCalls(
  parts: Array<{
    type: string
    id?: string
    name?: string
    input?: unknown
    arguments?: string
  }>,
): ToolCallSummary[] {
  const seen = new Set<string>()
  const tools: ToolCallSummary[] = []
  for (const part of parts) {
    if (part.type !== "tool-call") continue
    const name = part.name?.trim() || "tool"
    const id = part.id?.trim() || `${name}-${tools.length}`
    if (seen.has(id)) continue
    seen.add(id)
    tools.push({
      id,
      name,
      bucket: toolBucket(name),
      detail: toolCallDetail(part),
    })
  }
  return tools
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

export function collapsedToolChips(
  counts: ToolBucketCounts,
): Array<{ bucket: ToolBucket; label: string }> {
  const chips: Array<{ bucket: ToolBucket; label: string }> = []
  if (counts.reads > 0) {
    chips.push({
      bucket: "read",
      label: counts.reads === 1 ? "Read 1 file" : `Read ${counts.reads} files`,
    })
  }
  if (counts.searches > 0) {
    chips.push({
      bucket: "search",
      label: counts.searches === 1 ? "1 search" : `${counts.searches} searches`,
    })
  }
  if (counts.tools > 0) {
    chips.push({
      bucket: "tool",
      label: counts.tools === 1 ? "Used 1 tool" : `Used ${counts.tools} tools`,
    })
  }
  return chips
}

export function collapsedToolSummary(counts: ToolBucketCounts): string[] {
  return collapsedToolChips(counts).map((chip) => chip.label)
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

export function latestReasoningHeading(text: string): string | null {
  let last: string | null = null
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const title = reasoningHeadingTitle(line)
    if (title) last = title
  }
  return last
}

export function normalizeReasoningMarkdown(text: string): string {
  const prepared = text
    .replace(/\r\n/g, "\n")
    .replace(/([.!?])\s*(\*\*[^*]+\*\*)/g, "$1\n$2")
  const out: string[] = []
  for (const line of prepared.split("\n")) {
    if (reasoningHeadingTitle(line)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("")
      out.push(line.trim())
      out.push("")
      continue
    }
    out.push(line)
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
