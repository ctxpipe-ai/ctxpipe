import { parse as parseYaml } from "yaml"

export const KNOWLEDGE_SKILL_PATH = ".agents/skills/ctxpipe-knowledge/SKILL.md"
export const REPOSITORIES_DIR = "repositories"

export function greenfieldKnowledgePath(area: string, unit: string): string {
  return `knowledge/${slugSegment(area)}/${slugSegment(unit)}.md`
}

const KIND_AREAS: Record<string, string> = {
  Service: "services",
  App: "apps",
  Library: "libraries",
  API: "apis",
  Operation: "operations",
  Pattern: "patterns",
  Database: "databases",
  Infrastructure: "infrastructure",
  Stream: "streams",
  InstructionUnit: "instructions",
  Repository: "codebases",
}

export function knowledgeAreaFromObjectKind(kind: string): string {
  const mapped = KIND_AREAS[kind.trim()]
  if (mapped) return mapped
  const slug = slugSegment(kind)
  return slug === "item" ? "topics" : slug
}

export function isImportedKnowledgePath(path: string): boolean {
  return path.startsWith("knowledge/imported/")
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
  const yamlText = trimmed.slice(4, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\n/, "")
  try {
    const parsed = parseYaml(yamlText)
    if (parsed == null) {
      return { attributes: {}, body, malformed: false }
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { attributes: {}, body: trimmed, malformed: true }
    }
    return {
      attributes: parsed as Record<string, unknown>,
      body,
      malformed: false,
    }
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

