export const KNOWLEDGE_SKILL_PATH = ".agents/skills/ctxpipe-knowledge/SKILL.md"
export const REPOSITORIES_DIR = "repositories"

export function greenfieldKnowledgePath(area: string, unit: string): string {
  return `knowledge/${slugSegment(area)}/${slugSegment(unit)}.md`
}

export function isConnectorMirrorPath(path: string): boolean {
  return (
    path.startsWith("linear/") ||
    path.startsWith("notion/") ||
    path.startsWith("confluence/")
  )
}

export function isLinkedRepositoryDeclaration(path: string): boolean {
  return (
    path.startsWith(`${REPOSITORIES_DIR}/`) &&
    path.endsWith(".md") &&
    !path.slice(REPOSITORIES_DIR.length + 1).includes("/")
  )
}

export function parseSimpleFrontMatter(raw: string): {
  attributes: Record<string, unknown>
  body: string
  malformed: boolean
} {
  const trimmed = raw.replace(/^\uFEFF/, "")
  if (!trimmed.startsWith("---")) {
    return { attributes: {}, body: trimmed, malformed: false }
  }
  const end = trimmed.indexOf("\n---", 3)
  if (end < 0) return { attributes: {}, body: trimmed, malformed: true }
  const yaml = trimmed.slice(4, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\n/, "")
  try {
    return { attributes: parseShallowYaml(yaml), body, malformed: false }
  } catch {
    return { attributes: {}, body: trimmed, malformed: true }
  }
}

export function parseLinkedRepositoryMarkdown(raw: string): {
  git: string
  branch: string | null
  malformed: boolean
} {
  const parsed = parseSimpleFrontMatter(raw)
  if (parsed.malformed) return { git: "", branch: null, malformed: true }
  const git =
    typeof parsed.attributes.git === "string"
      ? parsed.attributes.git.trim()
      : ""
  if (!git) return { git: "", branch: null, malformed: true }
  const branch =
    typeof parsed.attributes.branch === "string"
      ? parsed.attributes.branch.trim() || null
      : null
  return { git, branch, malformed: false }
}

function slugSegment(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "item"
}

function parseShallowYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line == null || !line.trim() || line.trim().startsWith("#")) {
      i += 1
      continue
    }
    if (/^claims:\s*$/.test(line)) {
      const claims: Record<string, unknown>[] = []
      i += 1
      let current: Record<string, unknown> | null = null
      while (i < lines.length) {
        const item = lines[i]
        if (item == null || (!item.startsWith(" ") && !item.startsWith("\t"))) {
          break
        }
        const start = item.match(/^\s+-\s+(?:(\w+):\s*(.*))?$/)
        if (start) {
          current = {}
          claims.push(current)
          if (start[1]) current[start[1]] = coerceScalar(start[2] ?? "")
          i += 1
          continue
        }
        const field = item.match(/^\s+(\w+):\s*(.*)$/)
        if (field?.[1] && current) {
          current[field[1]] = coerceScalar(field[2] ?? "")
        }
        i += 1
      }
      result.claims = claims
      continue
    }
    const pair = line.match(/^(\w+):\s*(.*)$/)
    if (!pair?.[1]) throw new Error("unsupported yaml")
    result[pair[1]] = coerceScalar(pair[2] ?? "")
    i += 1
  }
  return result
}

function coerceScalar(raw: string): string | number | boolean | null {
  const value = raw.trim()
  if (value === "" || value === "null" || value === "~") return null
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value.replace(/^["']|["']$/g, "")
}
