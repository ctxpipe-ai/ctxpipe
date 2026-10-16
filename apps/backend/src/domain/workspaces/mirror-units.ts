import { log } from "../../observability/logger.js"
import {
  confluencePageDedupKey,
  extractUrls,
  findLinearIdentifiers,
  issueDedupKey,
  linearWorkspaceOfUrl,
  normalizeLinearIdentifier,
  parseConfluencePageUrl,
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
 * `pagerduty/incidents/…`, `github/pulls/<owner>/<repo>/<file>.md`,
 * `plain/help-centers/<id>/…`, `plain/threads/labels/<id>/…`.
 */
export function mirrorUnitKind(path: string): string | null {
  const parts = path.split("/")
  const file = parts.at(-1)
  switch (parts[0]) {
    case "notion":
      if (file !== "index.md") return null
      if (parts[1] === "pages") return "Page"
      if (parts[1] === "databases") {
        return parts.includes("rows") ? "Page" : "Database"
      }
      return null
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
    case "github":
      return parts[1] === "pulls" && parts.length === 5 ? "PullRequest" : null
    case "plain":
      if (parts[1] === "help-centers" && parts.length === 4) return "Article"
      return parts[1] === "threads" &&
        parts[2] === "labels" &&
        parts.length === 5
        ? "Ticket"
        : null
    default:
      return null
  }
}

/**
 * The scheme of a link that hydrate resolved from a URL or an identifier.
 * `workspace:<path>` names a path from the Workspace root. A person writes
 * no such link, so a `/` link that a person wrote keeps its meaning.
 */
export const WORKSPACE_LINK_SCHEME = "workspace:"

/** The sites whose URLs can name a unit of this Workspace. */
type ProviderSites = {
  /** Hosts of the org's Confluence connections, for example `acme.atlassian.net`. */
  confluenceHosts: ReadonlySet<string>
  /** Linear workspace slugs that the Linear mirror files name in their `url`. */
  linearWorkspaces: ReadonlySet<string>
}

function notionIdKey(id: string): string {
  return id.replaceAll("-", "").toLowerCase()
}

function parseNotionPageUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (
    host !== "notion.so" &&
    !host.endsWith(".notion.so") &&
    !host.endsWith(".notion.site")
  ) {
    return null
  }
  const match =
    /(?:^|-)([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.exec(
      url.pathname.split("/").filter(Boolean).at(-1) ?? "",
    )
  return match?.[1] ? `notion:${notionIdKey(match[1])}` : null
}

/** Keys that a provider URL can name. Unknown URLs give no key. */
function urlKeys(url: string, sites: ProviderSites): string[] {
  const keys: string[] = []
  const linearWorkspace = linearWorkspaceOfUrl(url)
  if (linearWorkspace && sites.linearWorkspaces.has(linearWorkspace)) {
    const issue = parseLinearIssueUrl(url)
    if (issue) keys.push(issueDedupKey(issue))
    const entity = parseLinearEntityUrl(url)
    if (entity) keys.push(entity)
  }
  const page = parseConfluencePageUrl(url)
  if (page && sites.confluenceHosts.has(page.host)) {
    keys.push(confluencePageDedupKey(page.pageId))
  }
  const thread = parseSlackPermalink(url)
  if (thread) keys.push(threadDedupKey(thread.channelId, thread.ts))
  const notionId = parseNotionPageUrl(url)
  if (notionId) keys.push(notionId)
  return keys
}

/** The Confluence page id that a mirror file name carries, or null. */
function confluencePageIdOfPath(path: string): string | null {
  if (!path.startsWith("confluence/")) return null
  return /(?:^|\/)[^/]+--(\d+)(?:\.md|\/index\.md)$/.exec(path)?.[1] ?? null
}

/** The Linear issue identifier in a mirror file's front matter, or null. */
function linearIdentifierOf(
  attributes: Record<string, unknown>,
): string | null {
  return typeof attributes.identifier === "string"
    ? normalizeLinearIdentifier(attributes.identifier)
    : null
}

/** The keys under which other files can name one mirror unit. */
function unitKeys(
  path: string,
  attributes: Record<string, unknown>,
  sites: ProviderSites,
): string[] {
  const keys: string[] = []
  if (typeof attributes.notion_id === "string") {
    const id = attributes.notion_id.trim()
    if (
      /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(
        id,
      )
    ) {
      keys.push(`notion:${notionIdKey(id)}`)
    }
  }
  if (typeof attributes.url === "string") {
    keys.push(...urlKeys(attributes.url, sites))
  }
  const identifier = linearIdentifierOf(attributes)
  if (identifier) keys.push(issueDedupKey(identifier))
  const page = confluencePageIdOfPath(path)
  if (page) keys.push(confluencePageDedupKey(page))
  const thread =
    /^slack\/channels\/[^/]+--([A-Z0-9]+)\/threads\/\d{4}\/\d{2}\/(\d+\.\d+)\/thread\.md$/.exec(
      path,
    )
  if (thread?.[1] && thread[2]) keys.push(threadDedupKey(thread[1], thread[2]))
  return keys
}

/**
 * `https://github.com/<owner>/<repo>/blob/<ref>/<path>` of the Workspace
 * repository → the Workspace path after the ref, when that file exists. The
 * ref is one path segment. A URL whose ref holds `/` stays external, so no
 * shorter path can match by mistake.
 */
function workspaceBlobPath(
  url: string,
  workspaceRepository: string | null,
  paths: ReadonlySet<string>,
): string | null {
  if (!workspaceRepository) return null
  const parsed = new URL(url)
  if (parsed.hostname.toLowerCase() !== "github.com") return null
  const [owner, repo, blob, ref, ...rest] = parsed.pathname
    .split("/")
    .filter(Boolean)
  if (blob !== "blob" || !owner || !repo || !ref || rest.length === 0) {
    return null
  }
  if (
    normalizeWorkspaceRepositoryUrl(`https://github.com/${owner}/${repo}`) !==
    workspaceRepository
  ) {
    return null
  }
  const candidate = decodeURIComponent(rest.join("/"))
  return paths.has(candidate) ? candidate : null
}

/**
 * `workspace:<path>` links for each unit: the URLs and the Linear
 * identifiers of known teams that name another unit of the Workspace. A
 * reference to a thing that the Workspace does not hold gives no link, so it
 * stays external. A relative Confluence link whose page moved resolves by
 * the page id. A reference that fails to parse is skipped with a warning; it
 * never stops hydrate.
 */
export function referenceLinks(input: {
  units: ReadonlyArray<{
    path: string
    body: string
    links: readonly string[]
    attributes: Record<string, unknown>
  }>
  workspaceUrl?: string
  /** Hosts of the org's Confluence connections. */
  confluenceSiteHosts?: ReadonlySet<string>
  resolveLink: (fromDir: string, href: string) => string
}): Map<string, string[]> {
  const paths = new Set(input.units.map((unit) => unit.path))
  const linearWorkspaces = new Set<string>()
  for (const unit of input.units) {
    const url = unit.attributes.url
    if (!unit.path.startsWith("linear/") || typeof url !== "string") continue
    const workspace = linearWorkspaceOfUrl(url)
    if (workspace) linearWorkspaces.add(workspace)
  }
  const confluenceHosts = new Set(
    [...(input.confluenceSiteHosts ?? [])].map((host) => host.toLowerCase()),
  )
  const sites: ProviderSites = {
    // A page id is unique only in its site, and a mirror path names no site.
    // With two or more sites, a Confluence URL could join the wrong page.
    confluenceHosts: confluenceHosts.size === 1 ? confluenceHosts : new Set(),
    linearWorkspaces,
  }

  const byKey = new Map<string, string[]>()
  const teamKeys = new Set<string>()
  for (const unit of input.units) {
    for (const key of unitKeys(unit.path, unit.attributes, sites)) {
      const list = byKey.get(key) ?? []
      if (!list.includes(unit.path)) list.push(unit.path)
      byKey.set(key, list)
    }
    const identifier = linearIdentifierOf(unit.attributes)
    if (identifier) teamKeys.add(identifier.split("-")[0] ?? "")
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
    const guarded = (what: string, resolve: () => void) => {
      try {
        resolve()
      } catch (error) {
        log.warn({
          step: "workspace-hydrate.reference-links",
          message: `A ${what} reference was skipped: ${error instanceof Error ? error.message : String(error)}`,
          path: unit.path,
        })
      }
    }
    const urls = extractUrls(unit.body)
    for (const url of urls) {
      guarded("URL", () => {
        for (const key of urlKeys(url, sites)) addKey(key)
        const blob = workspaceBlobPath(url, workspaceRepository, paths)
        if (blob) targets.add(blob)
      })
    }
    // An identifier inside a Linear link (its text or its URL) is the
    // link's, so the URL check decides it.
    const text = urls.reduce(
      (body, url) => body.replaceAll(url, " "),
      unit.body.replace(
        /\[[^\]]*\]\((https?:\/\/linear\.app\/[^)\s]*)\)/gi,
        " ",
      ),
    )
    guarded("Linear identifier", () => {
      for (const identifier of findLinearIdentifiers(text, [...teamKeys])) {
        addKey(issueDedupKey(identifier))
      }
    })
    const dir = unit.path.split("/").slice(0, -1).join("/")
    for (const href of unit.links) {
      guarded("Confluence link", () => {
        const target = input.resolveLink(dir, href)
        if (paths.has(target)) return
        const page = confluencePageIdOfPath(target)
        if (page) addKey(confluencePageDedupKey(page))
      })
    }
    targets.delete(unit.path)
    if (targets.size > 0) {
      out.set(
        unit.path,
        [...targets]
          .sort()
          .map((target) => `${WORKSPACE_LINK_SCHEME}${target}`),
      )
    }
  }
  return out
}
