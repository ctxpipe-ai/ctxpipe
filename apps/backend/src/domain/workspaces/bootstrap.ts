import { KNOWLEDGE_SKILL_PATH, parseSimpleFrontMatter } from "./layout.js"
import { isBootstrapAllowedPath } from "./write-jobs.js"

export const BOOTSTRAP_SKILL_PATH = KNOWLEDGE_SKILL_PATH

const FOLDER_MAP_HEADING =
  /^#{1,6}\s+.*\b(folders?|director(?:y|ies)|layout|structure)\b/i
const DEFAULT_FOLDER_MAP = `## Folder Structure

- \`knowledge/\` — workspace knowledge units
- \`.ctxpipe/sources.yaml\` — sources, including linked GitHub repositories`

const DEFAULT_SKILL = `---
name: ctxpipe-knowledge
---

# ctxpipe knowledge

Write reviewable markdown. Hydrate copies these files into the serving store; it does not infer claims from prose.

## Layout

- Greenfield: \`knowledge/<area>/<unit>.md\`
- Existing tree: match the folders already present
- Linked repositories: GitHub sources in \`.ctxpipe/sources.yaml\` (change them in the Sources settings, not in a file)
- Do not rewrite \`notion/\`, \`linear/\`, or \`confluence/\`

## Schema

Knowledge files need no required keys. Optional \`claims:\` items use file-relative \`to\`. Skip an item if \`to\` is missing.

## Confidence

Calibrate in the file: **0.5** typical, **0.7** strong, **≥0.85** rare. Ask how sure the user is. Set \`valid_to\` from the source when it has an end date.

## What a good unit looks like

One unit per file. Keep it short. Link to other units instead of pasting them. Add claims only for facts you would defend. No meeting-dump blobs. No serving-store jargon (\`obj_\`, SPO tables) in the file.
`

export function bootstrapAgentsMarkdown(input: {
  displayName: string
  existing?: string | null
}): string {
  const name = input.displayName.trim() || "Workspace"
  const existing = input.existing?.trim() ?? ""
  if (!existing) {
    return `${serializeFrontMatter({ name })}\n\n${DEFAULT_FOLDER_MAP}\n`
  }

  const parsed = parseSimpleFrontMatter(existing)
  if (parsed.malformed) return existing

  const currentName =
    typeof parsed.attributes.name === "string" && parsed.attributes.name.trim()
      ? parsed.attributes.name.trim()
      : name
  const attributes = { ...parsed.attributes, name: currentName }
  const body = ensureFolderStructureSection(parsed.body)
  return `${serializeFrontMatter(attributes)}\n\n${body.trim()}\n`
}

export function bootstrapKnowledgeSkillMarkdown(
  existing?: string | null,
): string {
  const current = existing?.trim() ?? ""
  if (!current) return DEFAULT_SKILL
  const parsed = parseSimpleFrontMatter(current)
  if (parsed.malformed) return current
  const missing: string[] = []
  if (!/knowledge\/<area>/i.test(current) && !/knowledge\//i.test(current)) {
    missing.push("## Layout\n\n- Greenfield: `knowledge/<area>/<unit>.md`")
  }
  if (!/0\.5/.test(current) || !/0\.7/.test(current)) {
    missing.push(
      "## Confidence\n\nCalibrate in the file: **0.5** typical, **0.7** strong, **≥0.85** rare.",
    )
  }
  if (!/obj_/.test(current)) {
    missing.push(
      "## What a good unit looks like\n\nNo serving-store jargon (`obj_`, SPO tables) in the file.",
    )
  }
  if (missing.length === 0)
    return current.endsWith("\n") ? current : `${current}\n`
  return `${serializeFrontMatter(parsed.attributes)}\n\n${parsed.body.trim()}\n\n${missing.join("\n\n")}\n`
}

export function bootstrapWorkspaceFiles(input: {
  displayName: string
  existing: ReadonlyMap<string, string>
}): Array<{ path: string; content: string }> {
  const files = [
    {
      path: "AGENTS.md",
      content: bootstrapAgentsMarkdown({
        displayName: input.displayName,
        existing: input.existing.get("AGENTS.md"),
      }),
    },
    {
      path: BOOTSTRAP_SKILL_PATH,
      content: bootstrapKnowledgeSkillMarkdown(
        input.existing.get(BOOTSTRAP_SKILL_PATH),
      ),
    },
  ]
  return files.filter((file) => isBootstrapAllowedPath(file.path))
}

function formatFrontMatterScalar(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value)
  }
  return String(value)
}

function serializeFrontMatterValue(key: string, value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`]
    const lines = [`${key}:`]
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>)
        const first = entries[0]
        if (!first) {
          lines.push("  - {}")
          continue
        }
        lines.push(`  - ${first[0]}: ${formatFrontMatterScalar(first[1])}`)
        for (const [field, fieldValue] of entries.slice(1)) {
          lines.push(`    ${field}: ${formatFrontMatterScalar(fieldValue)}`)
        }
        continue
      }
      lines.push(`  - ${formatFrontMatterScalar(item)}`)
    }
    return lines
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${key}: {}`]
    const lines = [`${key}:`]
    for (const [field, fieldValue] of entries) {
      lines.push(`  ${field}: ${formatFrontMatterScalar(fieldValue)}`)
    }
    return lines
  }
  return [`${key}: ${formatFrontMatterScalar(value)}`]
}

function serializeFrontMatter(attributes: Record<string, unknown>): string {
  const lines = ["---"]
  for (const [key, value] of Object.entries(attributes)) {
    lines.push(...serializeFrontMatterValue(key, value))
  }
  lines.push("---")
  return lines.join("\n")
}

function ensureFolderStructureSection(body: string): string {
  // Old marker lines are removed by the folder-list job, not here.
  if (body.split(/\r?\n/).some((line) => FOLDER_MAP_HEADING.test(line.trim())))
    return body
  const trimmed = body.trim()
  return trimmed ? `${trimmed}\n\n${DEFAULT_FOLDER_MAP}` : DEFAULT_FOLDER_MAP
}
