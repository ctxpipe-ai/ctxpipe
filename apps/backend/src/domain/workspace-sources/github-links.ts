import { applySourceFileChange, SourceChangeError } from "./edit.js"
import { githubScopeSchema } from "./providers/github.js"
import {
  type ParsedSourceEntry,
  parseSourceEntry,
  type SourceEntry,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/** The id of the GitHub source that link and the upgrade make. */
export const LINKED_REPOSITORIES_SOURCE_KEY = "linked-repositories"

type ScopeItem = string | { name: string; ref?: string }

function itemName(item: ScopeItem): string {
  return typeof item === "string" ? item : item.name
}

function readEntries(text: string | null): ParsedSourceEntry[] {
  let file: ReturnType<typeof sourcesFileSchema.safeParse>
  try {
    file = sourcesFileSchema.safeParse(
      parseSourcesYaml(text?.trim() ? text : "version: 1\nsources: []\n"),
    )
  } catch (error) {
    throw new SourceChangeError(
      409,
      `The sources file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!file.success)
    throw new SourceChangeError(
      409,
      "The sources file does not match version 1. Fix it in git first.",
    )
  return file.data.sources.map(parseSourceEntry)
}

function githubEntries(entries: readonly ParsedSourceEntry[]): SourceEntry[] {
  return entries.flatMap((parsed) =>
    parsed.ok && parsed.entry.provider === "github" ? [parsed.entry] : [],
  )
}

function scopeItems(entry: SourceEntry): ScopeItem[] {
  const scope = githubScopeSchema.safeParse(entry.scope)
  return scope.success ? scope.data.repositories : []
}

/**
 * Link GitHub repositories (`owner/name`, with an optional branch or tag) in
 * the text of `.ctxpipe/sources.yaml` (ADR-050). A repository that a GitHub
 * entry already links is not added again. The others go into the GitHub entry
 * of `connectionId` (the `linked-repositories` entry first), or into a new
 * `linked-repositories` entry. Returns the new text, or null when nothing
 * changes. Throws {@link SourceChangeError} when the file is not valid.
 */
export function linkGithubRepositories(input: {
  sourcesFile: string | null
  connectionId: string
  repositories: ReadonlyArray<{ name: string; ref: string | null }>
}): string | null {
  const entries = readEntries(input.sourcesFile)
  const github = githubEntries(entries)
  const covered = new Set(
    github.flatMap(scopeItems).map((item) => itemName(item).toLowerCase()),
  )
  const missing: ScopeItem[] = []
  for (const { name, ref } of input.repositories) {
    if (covered.has(name.toLowerCase())) continue
    covered.add(name.toLowerCase())
    missing.push(ref ? { name, ref } : name)
  }
  if (!missing.length) return null
  const target =
    github.find(
      (entry) =>
        entry.key === LINKED_REPOSITORIES_SOURCE_KEY &&
        entry.connectionId === input.connectionId,
    ) ?? github.find((entry) => entry.connectionId === input.connectionId)
  const keyTaken = entries.some(
    (parsed) =>
      (parsed.ok ? parsed.entry.key : parsed.key) ===
      LINKED_REPOSITORIES_SOURCE_KEY,
  )
  return applySourceFileChange(
    input.sourcesFile,
    target
      ? {
          action: "edit",
          sourceKey: target.key,
          provider: "github",
          connectionId: target.connectionId,
          scope: { repositories: [...scopeItems(target), ...missing] },
        }
      : {
          action: "add",
          sourceKey: keyTaken ? undefined : LINKED_REPOSITORIES_SOURCE_KEY,
          provider: "github",
          connectionId: input.connectionId,
          scope: { repositories: missing },
        },
  ).text
}

/**
 * Unlink one GitHub repository (`owner/name`) from each GitHub entry of the
 * file. An entry with no repository left is removed. Returns the new text, or
 * null when no entry links the repository. Throws {@link SourceChangeError}
 * when the file is not valid.
 */
export function unlinkGithubRepository(input: {
  sourcesFile: string | null
  name: string
}): string | null {
  const target = input.name.toLowerCase()
  let text = input.sourcesFile
  let changed = false
  for (const entry of githubEntries(readEntries(text))) {
    const items = scopeItems(entry)
    const kept = items.filter((item) => itemName(item).toLowerCase() !== target)
    if (kept.length === items.length) continue
    changed = true
    text = applySourceFileChange(
      text,
      kept.length
        ? {
            action: "edit",
            sourceKey: entry.key,
            provider: "github",
            connectionId: entry.connectionId,
            scope: { repositories: kept },
          }
        : { action: "remove", sourceKey: entry.key },
    ).text
  }
  return changed ? text : null
}
