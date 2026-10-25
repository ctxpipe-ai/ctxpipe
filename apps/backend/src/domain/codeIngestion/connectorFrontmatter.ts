import { parse as parseYaml } from "yaml"

/** Shared, defensive helpers for connector Markdown (YAML frontmatter + body). */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

/**
 * The front matter of a Markdown file: its data, its raw lines (none for an
 * empty `---` pair), and the text after the closing `---`.
 */
export function splitFrontmatter(
  content: string,
): { data: Record<string, unknown>; lines: string[]; body: string } | null {
  const match = content.match(/^---\n(?:---|([\s\S]*?)\n---)/)
  if (!match) return null
  const yaml = match[1]
  let parsed: unknown
  try {
    parsed = yaml === undefined ? {} : parseYaml(yaml)
  } catch {
    return null
  }
  const data = asRecord(parsed ?? {})
  if (!data) return null
  return {
    data,
    lines: yaml === undefined ? [] : yaml.split("\n"),
    body: content.slice(match[0].length),
  }
}
