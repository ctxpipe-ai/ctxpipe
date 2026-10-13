import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { McpToolError } from "./tool-errors.js"

export type HandledRepository = {
  /** `owner/name`, or `host/owner/name` when `owner/name` collides in the org. */
  handle: string
  /** `normalizeWorkspaceRepositoryUrl` form of the first linked URL. */
  url: string
}

type Located = { host: string; path: string }

/**
 * Host and path of a git URL after `normalizeWorkspaceRepositoryUrl`. The key
 * ignores the scheme and the letter case, so SSH, HTTPS, `ssh://` and `.git`
 * forms of one repository give the same key.
 */
function locate(raw: string): Located | null {
  const normalized = normalizeWorkspaceRepositoryUrl(raw)
  try {
    const url = new URL(normalized)
    const path = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase()
    if (!url.hostname || !path) return null
    const host = (
      url.port ? `${url.hostname}:${url.port}` : url.hostname
    ).toLowerCase()
    return { host, path }
  } catch {
    return null
  }
}

function keyOf(located: Located): string {
  return `${located.host}/${located.path}`
}

function looksLikeUrl(input: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[^@/\s]+@[^:]+:/.test(input)
  )
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
    const trimmed = input.trim()
    if (looksLikeUrl(trimmed)) {
      const located = locate(trimmed)
      if (!located) return []
      const key = keyOf(located)
      return this.entries.filter((entry) => entry.key === key)
    }
    const wanted = trimmed
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase()
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
   * each host. A URL that is not linked still excludes that repository.
   */
  exclusion(inputs: readonly string[]): RepositoryExclusion {
    const keys = new Set<string>()
    for (const input of inputs) {
      const matches = this.match(input)
      for (const entry of matches) keys.add(entry.key)
      if (matches.length === 0 && looksLikeUrl(input.trim())) {
        const located = locate(input)
        if (located) keys.add(keyOf(located))
      }
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
