import {
  confluencePageDedupKey,
  extractUrls,
  findLinearIdentifiers,
  normalizeLinearIdentifier,
  parseConfluencePageUrl,
  parseGithubPullRequestUrl,
  parseLinearEntityUrl,
  parseLinearIssueUrl,
  parseSlackPermalink,
  threadDedupKey,
} from "../codeIngestion/referenceResolver.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/**
 * Connector-mirror units in the Workspace graph (CTX-530): the node kind
 * that a mirror path names, and the edges that the URLs and Linear
 * identifiers in a mirror file make to other units of the same Workspace.
 * The URL parsers are in `referenceResolver.ts` (ADR-033).
 */

/** The Linear walk directory, which is the parent of each file, → kind. */
const LINEAR_KINDS: Record<string, string> = {
  issues: "Issue",
  projects: "Project",
  teams: "Team",
  cycles: "Cycle",
  documents: "Document",
  initiatives: "Initiative",
  "customer-requests": "CustomerRequest",
  labels: "Label",
  users: "User",
}

/**
 * The kind of a Markdown file at a connector-mirror path, or null. Layouts:
 * `confluence/<KEY>/…`, `linear/teams/<KEY>/<dir>/…`,
 * `linear/projects/<id>/<dir>/…`, `slack/channels/<channel>/…`,
 * `pagerduty/incidents/…`.
 */
export function mirrorUnitKind(path: string): string | null {
  const parts = path.split("/")
  const file = parts.at(-1)
  switch (parts[0]) {
    case "confluence":
      return parts.length >= 3 && !parts.includes("_assets") ? "Page" : null
    case "linear":
      return parts.length >= 4
        ? (LINEAR_KINDS[parts.at(-2) ?? ""] ?? null)
        : null
    case "slack":
      if (parts[1] !== "channels") return null
      if (file === "thread.md") return "Thread"
      return parts.length === 4 && file === "index.md" ? "Channel" : null
    case "pagerduty":
      return parts[1] === "incidents" ? "Incident" : null
    default:
      return null
  }
}

/** Keys that a provider URL can name. Unknown URLs give no key. */
function urlKeys(url: string): string[] {
  const keys: string[] = []
  const issue = parseLinearIssueUrl(url)
  if (issue) keys.push(`iss:linear:${issue}`)
  const entity = parseLinearEntityUrl(url)
  if (entity) keys.push(entity)
  const page = parseConfluencePageUrl(url)
  if (page) keys.push(confluencePageDedupKey(page))
  const thread = parseSlackPermalink(url)
  if (thread) keys.push(threadDedupKey(thread.channelId, thread.ts))
  const pull = parseGithubPullRequestUrl(url)
  if (pull)
    keys.push(`prq:github:${pull.repository.toLowerCase()}:${pull.number}`)
  return keys
}

/** The Confluence page id that a mirror file name carries, or null. */
function confluencePageIdOfPath(path: string): string | null {
  if (!path.startsWith("confluence/")) return null
  return /(?:^|\/)[^/]+--(\d+)(?:\.md|\/index\.md)$/.exec(path)?.[1] ?? null
}

/** The keys under which other files can name one mirror unit. */
function unitKeys(path: string, attributes: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (typeof attributes.url === "string") keys.push(...urlKeys(attributes.url))
  if (typeof attributes.identifier === "string") {
    const identifier = normalizeLinearIdentifier(attributes.identifier)
    if (identifier) keys.push(`iss:linear:${identifier}`)
  }
  const page = confluencePageIdOfPath(path)
  if (page) keys.push(confluencePageDedupKey(page))
  const thread =
    /^slack\/channels\/[^/]+--([A-Z0-9]+)\/threads\/\d{4}\/\d{2}\/(\d+\.\d+)\/thread\.md$/.exec(
      path,
    )
  if (thread?.[1] && thread[2]) keys.push(threadDedupKey(thread[1], thread[2]))
  return keys
}

/** URLs that a mirror file names in its front matter, apart from its own. */
function frontMatterUrls(attributes: Record<string, unknown>): string[] {
  const references = attributes.githubReferences
  if (!Array.isArray(references)) return []
  return references.flatMap((reference) =>
    reference &&
    typeof reference === "object" &&
    typeof (reference as { url?: unknown }).url === "string"
      ? [(reference as { url: string }).url]
      : [],
  )
}

/**
 * `https://github.com/<owner>/<repo>/blob/<ref>/<path>` of the Workspace
 * repository → a Workspace path that exists. A ref can hold `/`, so each
 * split is tried.
 */
function workspaceBlobPath(
  url: string,
  workspaceRepository: string | null,
  paths: ReadonlySet<string>,
): string | null {
  if (!workspaceRepository) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null
  const [owner, repo, blob, ...rest] = parsed.pathname
    .split("/")
    .filter(Boolean)
  if (blob !== "blob" || !owner || !repo) return null
  if (
    normalizeWorkspaceRepositoryUrl(`https://github.com/${owner}/${repo}`) !==
    workspaceRepository
  ) {
    return null
  }
  for (let start = 1; start < rest.length; start += 1) {
    const candidate = decodeURIComponent(rest.slice(start).join("/"))
    if (paths.has(candidate)) return candidate
  }
  return null
}

/**
 * Workspace-root links (`/<path>`) for each unit: the URLs and the Linear
 * identifiers of known teams that name another unit of the Workspace. A
 * reference to a thing that the Workspace does not hold gives no link, so it
 * stays external. A relative Confluence link whose page moved resolves by
 * the page id.
 */
export function referenceLinks(input: {
  units: ReadonlyArray<{
    path: string
    body: string
    links: readonly string[]
    attributes: Record<string, unknown>
  }>
  workspaceUrl?: string
  resolveLink: (fromDir: string, href: string) => string
}): Map<string, string[]> {
  const paths = new Set(input.units.map((unit) => unit.path))
  const byKey = new Map<string, string[]>()
  const teamKeys = new Set<string>()
  for (const unit of input.units) {
    for (const key of unitKeys(unit.path, unit.attributes)) {
      const list = byKey.get(key) ?? []
      if (!list.includes(unit.path)) list.push(unit.path)
      byKey.set(key, list)
      if (key.startsWith("iss:linear:")) {
        teamKeys.add(key.slice("iss:linear:".length).split("-")[0] ?? "")
      }
    }
  }
  if (byKey.size === 0 && !input.workspaceUrl) return new Map()
  const workspaceRepository = input.workspaceUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceUrl)
    : null

  const out = new Map<string, string[]>()
  for (const unit of input.units) {
    const targets = new Set<string>()
    const addKey = (key: string) => {
      for (const target of byKey.get(key) ?? []) targets.add(target)
    }
    for (const url of [
      ...extractUrls(unit.body),
      ...frontMatterUrls(unit.attributes),
    ]) {
      for (const key of urlKeys(url)) addKey(key)
      const blob = workspaceBlobPath(url, workspaceRepository, paths)
      if (blob) targets.add(blob)
    }
    for (const identifier of findLinearIdentifiers(unit.body, [...teamKeys])) {
      addKey(`iss:linear:${identifier}`)
    }
    const dir = unit.path.split("/").slice(0, -1).join("/")
    for (const href of unit.links) {
      const target = input.resolveLink(dir, href)
      if (paths.has(target)) continue
      const page = confluencePageIdOfPath(target)
      if (page) addKey(confluencePageDedupKey(page))
    }
    targets.delete(unit.path)
    if (targets.size > 0) {
      out.set(
        unit.path,
        [...targets].sort().map((target) => `/${target}`),
      )
    }
  }
  return out
}
