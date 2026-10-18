import { applySourceFileChange, SourceChangeError } from "./edit.js"
import {
  GITHUB_SOURCE_MAX_REPOSITORIES,
  githubLegacyScopeSchema,
  githubScopeRepositories,
} from "./providers/github.js"
import { githubSourcePath } from "./source-file.js"
import { parseSourceFile } from "./source-file-text.js"
import {
  type ParsedSourceEntry,
  parseLegacySourceEntry,
  type SourceEntry,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"
import { applySourcesYamlChange } from "./sources-yaml-edit.js"

/**
 * The id of the GitHub entry in `.ctxpipe/sources.yaml` that the legacy
 * upgrade makes. CTX-721 T11 removes it with the YAML file.
 */
const LINKED_REPOSITORIES_SOURCE_KEY = "linked-repositories"

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
  // An entry from before the cap (CTX-822) can hold more repositories than
  // the cap. It still links them all.
  return file.data.sources.map(parseLegacySourceEntry)
}

function githubEntries(entries: readonly ParsedSourceEntry[]): SourceEntry[] {
  return entries.flatMap((parsed) =>
    parsed.ok && parsed.entry.provider === "github" ? [parsed.entry] : [],
  )
}

function scopeItems(entry: SourceEntry): LinkedItem[] {
  const scope = githubLegacyScopeSchema.safeParse(entry.scope)
  return scope.success ? githubScopeRepositories(scope.data) : []
}

/**
 * Link GitHub repositories (`owner/name`, with an optional branch or tag) in
 * the text of `.ctxpipe/sources.yaml` (ADR-050). A repository that a GitHub
 * entry already links is not added again; when that link has no ref and the
 * request has one, the link gets the ref. The others go into the GitHub
 * entries of `connectionId` (the `linked-repositories` entry first) until
 * each is full, then into new entries `linked-repositories`,
 * `linked-repositories-2`, and so on. No entry gets more than
 * {@link GITHUB_SOURCE_MAX_REPOSITORIES} repositories. Returns the new text,
 * or null when nothing changes. Throws {@link SourceChangeError} when the
 * file is not valid.
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
  // A stored entry above the cap cannot be written back. Its overflow goes
  // into new entries.
  for (const target of github)
    if (target.changed)
      missing.unshift(...target.items.splice(GITHUB_SOURCE_MAX_REPOSITORIES))
  const own = github.filter(
    ({ entry }) => entry.connectionId === input.connectionId,
  )
  for (const target of [
    ...own.filter(({ entry }) => entry.key === LINKED_REPOSITORIES_SOURCE_KEY),
    ...own.filter(({ entry }) => entry.key !== LINKED_REPOSITORIES_SOURCE_KEY),
  ]) {
    const room = GITHUB_SOURCE_MAX_REPOSITORIES - target.items.length
    if (room <= 0 || !missing.length) continue
    target.items.push(...missing.splice(0, room))
    target.changed = true
  }
  let text = input.sourcesFile
  for (const { entry, items, changed } of github) {
    if (!changed) continue
    text = applySourcesYamlChange(text, {
      action: "edit",
      sourceKey: entry.key,
      provider: "github",
      connectionId: entry.connectionId,
      scope: { repositories: items.map(scopeItem) },
    }).text
  }
  const taken = new Set(
    entries.flatMap(
      (parsed) => (parsed.ok ? parsed.entry.key : parsed.key) ?? [],
    ),
  )
  let suffix = 1
  while (missing.length) {
    let key = LINKED_REPOSITORIES_SOURCE_KEY
    while (taken.has(key)) key = `${LINKED_REPOSITORIES_SOURCE_KEY}-${++suffix}`
    taken.add(key)
    text = applySourcesYamlChange(text, {
      action: "add",
      sourceKey: key,
      provider: "github",
      connectionId: input.connectionId,
      scope: {
        repositories: missing
          .splice(0, GITHUB_SOURCE_MAX_REPOSITORIES)
          .map(scopeItem),
      },
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
    text = applySourcesYamlChange(
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

type RepoFile = { path: string; content: string }
type FileChanges = { writes: RepoFile[]; deletes: string[] }

/** Each valid GitHub source file, with its repository and ref. */
function githubSourceFiles(files: ReadonlyArray<RepoFile>) {
  return files.flatMap((file) => {
    const parsed = parseSourceFile(file.path, file.content)
    if (!parsed.ok || parsed.source.provider !== "github") return []
    const { repository, ref } = parsed.source.scope as {
      repository: string
      ref?: string
    }
    return [{ file, parsed, repository, ref: ref ?? null }]
  })
}

/**
 * Link one GitHub repository (`owner/name`, with an optional branch or tag):
 * write `sources/github/<owner>/<name>.md` (ADR-050, revision 2026-10-16).
 * `files` are the files under `sources/`. A repository that a GitHub source
 * file already links is not added again; when that file has no ref and the
 * request has one, the file gets the ref. Returns null when nothing changes.
 * Throws {@link SourceChangeError} when the new file cannot be made, for
 * example when another file has its path.
 */
export function linkGithubSourceFile(input: {
  files: ReadonlyArray<RepoFile>
  connectionId: string
  repository: { name: string; ref: string | null }
}): FileChanges | null {
  const { name, ref } = input.repository
  const existing = githubSourceFiles(input.files).find(
    (item) => item.repository.toLowerCase() === name.toLowerCase(),
  )
  if (!existing) {
    const { writes, deletes } = applySourceFileChange({
      files: input.files,
      change: {
        action: "add",
        provider: "github",
        connectionId: input.connectionId,
        scope: ref ? { repository: name, ref } : { repository: name },
      },
    })
    return { writes, deletes }
  }
  if (!ref || existing.ref !== null) return null
  const { writes, deletes } = applySourceFileChange({
    files: input.files,
    change: {
      action: "edit",
      path: existing.file.path,
      provider: "github",
      // A GitHub source file always has a connection.
      connectionId: existing.parsed.source.connectionId ?? input.connectionId,
      scope: { ...existing.parsed.source.scope, ref },
    },
  })
  return { writes, deletes }
}

/**
 * Unlink one GitHub repository (`owner/name`): delete each GitHub source
 * file that names it. Returns null when no file does. Throws
 * {@link SourceChangeError} when the file at the path of the repository
 * cannot be read, because then ctx| cannot tell what it links.
 */
export function unlinkGithubSourceFile(input: {
  files: ReadonlyArray<RepoFile>
  name: string
}): FileChanges | null {
  const [owner = "", repository = ""] = input.name.split("/")
  const path = githubSourcePath(owner, repository)
  const file = input.files.find((item) => item.path === path)
  const parsed = file ? parseSourceFile(file.path, file.content) : null
  if (parsed && !parsed.ok)
    throw new SourceChangeError(
      409,
      `${path} cannot be read: ${parsed.detail}. Fix it in git first.`,
    )
  const deletes = githubSourceFiles(input.files)
    .filter(
      (item) => item.repository.toLowerCase() === input.name.toLowerCase(),
    )
    .map((item) => item.file.path)
  return deletes.length ? { writes: [], deletes } : null
}
