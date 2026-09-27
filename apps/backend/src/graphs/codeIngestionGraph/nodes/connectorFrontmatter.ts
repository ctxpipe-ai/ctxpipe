import { parse as parseYaml } from "yaml"

/** Shared, defensive helpers for connector Markdown (YAML frontmatter + body). */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

export function splitFrontmatter(
  content: string,
): { data: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  let parsed: unknown
  try {
    parsed = parseYaml(match[1])
  } catch {
    return null
  }
  const data = asRecord(parsed)
  if (!data) return null
  return { data, body: content.slice(match[0].length) }
}

/** Drop a leading `# heading` line. */
export function stripLeadingHeading(body: string): string {
  const text = body.replace(/^\s+/, "")
  if (!text.startsWith("# ")) return text
  const newline = text.indexOf("\n")
  return newline === -1 ? "" : text.slice(newline + 1)
}

/** Body text up to the first heading matching `stopAt`, trimmed and capped. */
export function excerptOf(
  body: string,
  stopAt: RegExp | null,
  max = 2_000,
): string {
  let text = stripLeadingHeading(body)
  if (stopAt) {
    const cut = text.search(stopAt)
    if (cut !== -1) text = text.slice(0, cut)
  }
  return text.trim().slice(0, max)
}

export function firstParagraph(text: string, max = 500): string {
  const paragraph = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#"))
  return (paragraph ?? "").slice(0, max)
}
