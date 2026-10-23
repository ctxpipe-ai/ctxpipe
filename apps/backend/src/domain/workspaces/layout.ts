import { parse as parseYaml } from "yaml"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"

export const KNOWLEDGE_SKILL_PATH = ".agents/skills/ctxpipe-knowledge/SKILL.md"
const REPOSITORIES_DIR = "repositories"

export function greenfieldKnowledgePath(area: string, unit: string): string {
  return `knowledge/${slugSegment(area)}/${slugSegment(unit)}.md`
}

/**
 * A GitHub Actions workflow file: GitHub runs only the files directly in
 * `.github/workflows/`. The sandbox script `workflows.mjs` keeps its own copy.
 */
export const WORKFLOW_FILE_PATTERN =
  /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/

/** Knowledge folder for each object kind. */
export const KNOWLEDGE_KIND_FOLDERS: Readonly<Record<string, string>> = {
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
  Decision: "decisions",
  Team: "teams",
  Workflow: "workflows",
}

export function knowledgeAreaFromObjectKind(kind: string): string {
  const mapped = KNOWLEDGE_KIND_FOLDERS[kind.trim()]
  if (mapped) return mapped
  const slug = slugSegment(kind)
  return slug === "item" ? "topics" : slug
}

export function isImportedKnowledgePath(path: string): boolean {
  return path.startsWith("knowledge/imported/")
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
    return { attributes: {}, body: raw, malformed: false }
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
  if (!linkedRepositoryUrlSchema.safeParse(git).success)
    return { git: "", branch: null, malformed: true }
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
