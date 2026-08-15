const SLUG_MAX = 64

/** Normalise a URL segment: lowercase, hyphenated, no leading/trailing hyphens. */
export function normalizeSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
  return slug.length > 0 ? slug : "workspace"
}

export function isValidSlug(raw: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) && raw.length <= SLUG_MAX
}

/**
 * Default slug from a git URL: GitHub repo name, or last path segment otherwise.
 */
export function slugFromGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim()
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/)
  if (ssh?.[2]) {
    const segment = lastPathSegment(ssh[2])
    return normalizeSlug(segment)
  }
  try {
    const url = new URL(trimmed)
    return normalizeSlug(lastPathSegment(url.pathname))
  } catch {
    return normalizeSlug(lastPathSegment(trimmed))
  }
}

export function displayNameFromGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim()
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/)
  if (ssh?.[2]) return lastPathSegment(ssh[2]) || "Workspace"
  try {
    const url = new URL(trimmed)
    return lastPathSegment(url.pathname) || "Workspace"
  } catch {
    return lastPathSegment(trimmed) || "Workspace"
  }
}

function lastPathSegment(path: string): string {
  return (
    path
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
      .pop() ?? ""
  )
}

export function nextSlugCandidate(desired: string, taken: Set<string>): string {
  const base = normalizeSlug(desired)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error("Unable to allocate workspace slug")
}

/** Canonical form used for uniqueness of the workspace repository URL. */
export function normalizeWorkspaceRepositoryUrl(raw: string): string {
  const trimmed = raw.trim()
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/)
  if (ssh?.[1] && ssh[2]) {
    const host = ssh[1].toLowerCase()
    const path = ssh[2].replace(/\.git$/i, "").replace(/\/+$/, "")
    if (host === "github.com") return `https://github.com/${path}`
    return `https://${host}/${path}`
  }
  try {
    const url = new URL(trimmed)
    url.hash = ""
    url.search = ""
    url.username = ""
    url.password = ""
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "")
    if (url.hostname.toLowerCase() === "github.com") {
      url.protocol = "https:"
      url.hostname = "github.com"
      url.port = ""
    }
    return url.toString().replace(/\/$/, "")
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/\/+$/, "")
  }
}
