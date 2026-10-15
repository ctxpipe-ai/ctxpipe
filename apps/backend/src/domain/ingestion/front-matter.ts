import { parse as parseYaml } from "yaml"

/**
 * The YAML front matter of a Markdown file and the body after it, or null
 * when the file has no front matter. Ingestion reads ownership with this
 * function, so each check of the ownership fields must use it too.
 */
export function splitFrontMatter(
  text: string,
): { yaml: string; body: string } | null {
  const match = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return null
  return { yaml: match[1] ?? "", body: text.slice(match[0].length) }
}

export function parseYamlObject(yaml: string): Record<string, unknown> | null {
  try {
    const value = parseYaml(yaml) ?? {}
    return typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
