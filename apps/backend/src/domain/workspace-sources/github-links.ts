import { applySourceFileChange, SourceChangeError } from "./edit.js"
import {
  githubScopeRepositories,
  githubScopeSchema,
} from "./providers/github.js"
import {
  type ParsedSourceEntry,
  parseSourceEntry,
  type SourceEntry,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/** The id of the GitHub source that link and the upgrade make. */
export const LINKED_REPOSITORIES_SOURCE_KEY = "linked-repositories"

type LinkedItem = { name: string; ref: string | null }

/** The scope item of the file: `owner/name`, or a map when it has a ref. */
function scopeItem({ name, ref }: LinkedItem) {
  return ref ? { name, ref } : name
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

function scopeItems(entry: SourceEntry): LinkedItem[] {
  const scope = githubScopeSchema.safeParse(entry.scope)
  return scope.success ? githubScopeRepositories(scope.data) : []
}

/**
 * Link GitHub repositories (`owner/name`, with an optional branch or tag) in
 * the text of `.ctxpipe/sources.yaml` (ADR-050). A repository that a GitHub
 * entry already links is not added again; when that link has no ref and the
 * request has one, the link gets the ref. The others go into the GitHub entry
 * of `connectionId` (the `linked-repositories` entry first), or into a new
 * `linked-repositories` entry. Returns the new text, or null when nothing
 * changes. Throws {@link SourceChangeError} when the file is not valid.
 */
export function linkGithubRepositories(input: {
  sourcesFile: string | null
  connectionId: string
  repositories: ReadonlyArray<LinkedItem>
}): string | null {
  const entries = readEntries(input.sourcesFile)
  const github = githubEntries(entries).map((entry) => ({
    entry,
    items: scopeItems(entry),
    changed: false,
  }))
  const linked = new Map<
    string,
    { item: LinkedItem; owner?: (typeof github)[number] }
  >()
  for (const owner of github)
    for (const item of owner.items)
      if (!linked.has(item.name.toLowerCase()))
        linked.set(item.name.toLowerCase(), { item, owner })
  const missing: LinkedItem[] = []
  for (const { name, ref } of input.repositories) {
    const current = linked.get(name.toLowerCase())
    if (!current) {
      const item = { name, ref }
      linked.set(name.toLowerCase(), { item })
      missing.push(item)
    } else if (ref && current.item.ref === null && current.owner) {
      current.item.ref = ref
      current.owner.changed = true
    }
  }
  const target =
    github.find(
      ({ entry }) =>
        entry.key === LINKED_REPOSITORIES_SOURCE_KEY &&
        entry.connectionId === input.connectionId,
    ) ?? github.find(({ entry }) => entry.connectionId === input.connectionId)
  if (target && missing.length) {
    target.items.push(...missing)
    target.changed = true
  }
  let text = input.sourcesFile
  for (const { entry, items, changed } of github) {
    if (!changed) continue
    text = applySourceFileChange(text, {
      action: "edit",
      sourceKey: entry.key,
      provider: "github",
      connectionId: entry.connectionId,
      scope: { repositories: items.map(scopeItem) },
    }).text
  }
  if (!target && missing.length) {
    const keyTaken = entries.some(
      (parsed) =>
        (parsed.ok ? parsed.entry.key : parsed.key) ===
        LINKED_REPOSITORIES_SOURCE_KEY,
    )
    text = applySourceFileChange(text, {
      action: "add",
      sourceKey: keyTaken ? undefined : LINKED_REPOSITORIES_SOURCE_KEY,
      provider: "github",
      connectionId: input.connectionId,
      scope: { repositories: missing.map(scopeItem) },
    }).text
  }
  return text === input.sourcesFile ? null : text
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
    const kept = items.filter((item) => item.name.toLowerCase() !== target)
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
            scope: { repositories: kept.map(scopeItem) },
          }
        : { action: "remove", sourceKey: entry.key },
    ).text
  }
  return changed ? text : null
}
