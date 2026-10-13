import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { McpToolError } from "./tool-errors.js"

export type HandledRepository = {
  /** `owner/name`, or `host/owner/name` when `owner/name` collides in the org. */
  handle: string
  /** `normalizeWorkspaceRepositoryUrl` form of the first linked URL. */
  url: string
}

type Located = { host: string; path: string }

/** SCP-like git address: `[user@]host:path`, not `scheme://`. */
const SCP_ADDRESS = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/

function cleanPath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
}

/**
 * Host and path of a git address. The key ignores the scheme, the user, the
 * port, and the letter case, so SSH, SCP, HTTPS and `.git` forms of one
 * repository give the same key. URLs go through
 * `normalizeWorkspaceRepositoryUrl`.
 */
function locate(raw: string): Located | null {
  const trimmed = raw.trim()
  const scp = trimmed.match(SCP_ADDRESS)
  if (scp?.[1] && scp[2]) {
    const path = cleanPath(scp[2])
    return path ? { host: scp[1].toLowerCase(), path } : null
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(normalizeWorkspaceRepositoryUrl(trimmed))
    const path = cleanPath(url.pathname)
    if (!url.hostname || !path) return null
    return { host: url.hostname.toLowerCase(), path }
  } catch {
    return null
  }
}

function keyOf(located: Located): string {
  return `${located.host}/${located.path}`
}

type Entry = HandledRepository & { key: string; shortHandle: string }

/**
 * Readable handles for the linked repositories of one org (ADR-051 §4). Each
 * argument that names a repository accepts a handle or any git URL form.
 */
export class RepositoryHandles {
  private readonly entries: Entry[]

  private constructor(entries: Entry[]) {
    this.entries = entries
  }

  static from(gitUrls: readonly string[]): RepositoryHandles {
    const byKey = new Map<string, Located & { url: string }>()
    for (const raw of gitUrls) {
      const located = locate(raw)
      if (!located || byKey.has(keyOf(located))) continue
      byKey.set(keyOf(located), {
        ...located,
        url: normalizeWorkspaceRepositoryUrl(raw),
      })
    }
    const hostsByPath = new Map<string, Set<string>>()
    for (const repository of byKey.values()) {
      const hosts = hostsByPath.get(repository.path) ?? new Set<string>()
      hosts.add(repository.host)
      hostsByPath.set(repository.path, hosts)
    }
    return new RepositoryHandles(
      [...byKey.entries()].map(([key, repository]) => ({
        key,
        url: repository.url,
        shortHandle: repository.path,
        handle:
          (hostsByPath.get(repository.path)?.size ?? 0) > 1
            ? key
            : repository.path,
      })),
    )
  }

  list(): HandledRepository[] {
    return this.entries.map(({ handle, url }) => ({ handle, url }))
  }

  /** All linked repositories that an input (handle or URL) names. */
  private match(input: string): Entry[] {
    const located = locate(input)
    if (located) {
      const key = keyOf(located)
      return this.entries.filter((entry) => entry.key === key)
    }
    const wanted = cleanPath(input.trim())
    return this.entries.filter(
      (entry) => entry.key === wanted || entry.shortHandle === wanted,
    )
  }

  /** Exactly one linked repository, or `repository_not_found` / `ambiguous_repository`. */
  resolve(input: string): HandledRepository {
    const matches = this.match(input)
    const [only] = matches
    if (matches.length === 1 && only)
      return { handle: only.handle, url: only.url }
    if (matches.length > 1) {
      throw new McpToolError(
        "ambiguous_repository",
        `"${input}" names more than one repository. Use one of: ${matches.map((entry) => entry.handle).join(", ")}.`,
      )
    }
    throw new McpToolError(
      "repository_not_found",
      `No linked repository "${input}". Call list_workspaces with a workspace to see its repositories.`,
    )
  }

  /**
   * `excludeRepositories` matching. A short handle that collides excludes
   * each host. A git address that is not linked still excludes that
   * repository. An entry that is neither a linked handle nor a git address
   * gives `invalid_argument`, so a typo does not search the repository.
   */
  exclusion(inputs: readonly string[]): RepositoryExclusion {
    const keys = new Set<string>()
    for (const input of inputs) {
      const located = locate(input)
      if (located) {
        keys.add(keyOf(located))
        continue
      }
      const matches = this.match(input)
      if (matches.length === 0) {
        throw new McpToolError(
          "invalid_argument",
          `excludeRepositories: "${input}" is not a linked repository handle or a git remote URL. Pass the output of \`git remote get-url origin\`.`,
        )
      }
      for (const entry of matches) keys.add(entry.key)
    }
    return {
      excluded: this.entries
        .filter((entry) => keys.has(entry.key))
        .map((entry) => entry.handle),
      isExcluded: (gitUrl: string) => {
        const located = locate(gitUrl)
        return located !== null && keys.has(keyOf(located))
      },
    }
  }
}

export type RepositoryExclusion = {
  /** Handles of the linked repositories that the call excludes. */
  excluded: string[]
  isExcluded(gitUrl: string): boolean
}
