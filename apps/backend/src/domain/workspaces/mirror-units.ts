import { log } from "../../observability/logger.js"
import {
  confluencePageDedupKey,
  extractUrls,
  githubIssueOrPullDedupKey,
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
 * `github/issues/<owner>/<repo>/<number>.md`,
 * `buildkite/pipelines/<slug>/…`, `plain/help-centers/<id>/…`,
 * `plain/threads/labels/<id>/…`.
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
      if (parts.length !== 5) return null
      if (parts[1] === "pulls") return "PullRequest"
      return parts[1] === "issues" ? "Issue" : null
    case "buildkite":
      if (parts[1] !== "pipelines" || parts.length < 4) return null
      if (parts.length === 4 && file === "pipeline.md") return "Pipeline"
      return parts.length === 5 && parts[3] === "builds" ? "Build" : null
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

/**
 * A key that a unit has or names. A Linear key holds the Linear workspace of
 * its URL, and a Confluence key holds the site host of its URL: a key counts
 * only when the Workspace knows that Linear workspace or that single site.
 * The resolve step checks this, so a stored key stays valid when the sites
 * change.
 */
type SiteKey = { key: string; linear?: string; confluence?: string }

/** Keys that a provider URL can name. Unknown URLs give no key. */
function urlKeys(url: string): SiteKey[] {
  const keys: SiteKey[] = []
  const linearWorkspace = linearWorkspaceOfUrl(url)
  if (linearWorkspace) {
    const issue = parseLinearIssueUrl(url)
    if (issue) keys.push({ key: issueDedupKey(issue), linear: linearWorkspace })
    const entity = parseLinearEntityUrl(url)
    if (entity) keys.push({ key: entity, linear: linearWorkspace })
  }
  const page = parseConfluencePageUrl(url)
  if (page) {
    keys.push({
      key: confluencePageDedupKey(page.pageId),
      confluence: page.host,
    })
  }
  const thread = parseSlackPermalink(url)
  if (thread) keys.push({ key: threadDedupKey(thread.channelId, thread.ts) })
  const notionId = parseNotionPageUrl(url)
  if (notionId) keys.push({ key: notionId })
  const github = githubIssueOrPullDedupKey(url)
  if (github) keys.push({ key: github })
  return keys
}

function siteKeyCounts(key: SiteKey, sites: ProviderSites): boolean {
  return (
    (key.linear === undefined || sites.linearWorkspaces.has(key.linear)) &&
    (key.confluence === undefined || sites.confluenceHosts.has(key.confluence))
  )
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
): SiteKey[] {
  const keys: SiteKey[] = []
  if (typeof attributes.notion_id === "string") {
    const id = attributes.notion_id.trim()
    if (
      /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(
        id,
      )
    ) {
      keys.push({ key: `notion:${notionIdKey(id)}` })
    }
  }
  if (typeof attributes.url === "string") {
    keys.push(...urlKeys(attributes.url))
  }
  const identifier = linearIdentifierOf(attributes)
  if (identifier) keys.push({ key: issueDedupKey(identifier) })
  const page = confluencePageIdOfPath(path)
  if (page) keys.push({ key: confluencePageDedupKey(page) })
  const thread =
    /^slack\/channels\/[^/]+--([A-Z0-9]+)\/threads\/\d{4}\/\d{2}\/(\d+\.\d+)\/thread\.md$/.exec(
      path,
    )
  if (thread?.[1] && thread[2])
    keys.push({ key: threadDedupKey(thread[1], thread[2]) })
  return keys
}

/**
 * `https://github.com/<owner>/<repo>/blob/<ref>/<path>` → the repository and
 * the path after the ref. The ref is one path segment. A URL whose ref holds
 * `/` stays external, so no shorter path can match by mistake. The resolve
 * step keeps the path only when the repository is the Workspace repository
 * and the file exists.
 */
function githubBlobPath(
  url: string,
): { repository: string; path: string } | null {
  const parsed = new URL(url)
  if (parsed.hostname.toLowerCase() !== "github.com") return null
  const [owner, repo, blob, ref, ...rest] = parsed.pathname
    .split("/")
    .filter(Boolean)
  if (blob !== "blob" || !owner || !repo || !ref || rest.length === 0) {
    return null
  }
  return {
    repository: normalizeWorkspaceRepositoryUrl(
      `https://github.com/${owner}/${repo}`,
    ),
    path: decodeURIComponent(rest.join("/")),
  }
}

/**
 * The reference data of one unit that depends only on its own file: the
 * keys under which other units can name it, and the raw references that it
 * makes. Hydrate stores it with the unit (the reference index), so that a
 * partial hydrate can resolve the links of all units from Postgres and the
 * changed files only. `resolveReferenceLinks` applies the values that
 * depend on other files: the known Linear workspaces and team keys, the
 * Confluence site, and the set of paths.
 */
export type UnitReferences = {
  /** The keys under which other units can name this unit. */
  keys: SiteKey[]
  /** The Linear workspace of the `url` of a `linear/` unit. */
  linearWorkspace: string | null
  /** The team key of the Linear identifier of this unit. */
  teamKey: string | null
  /** The keys of the URLs in the body. */
  urls: SiteKey[]
  /** The GitHub blob URLs in the body. */
  blobs: Array<{ repository: string; path: string }>
  /** Each text that has the form of a Linear identifier, for each team. */
  identifiers: string[]
  /** Relative links to a Confluence page file, with the key of the page. */
  pages: Array<{ path: string; key: string }>
}

/**
 * The reference data of one unit (`UnitReferences`). A reference that fails
 * to parse is skipped with a warning; it never stops hydrate.
 */
export function extractUnitReferences(
  unit: {
    path: string
    body: string
    links: readonly string[]
    attributes: Record<string, unknown>
  },
  resolveLink: (fromDir: string, href: string) => string,
): UnitReferences {
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
  const url = unit.attributes.url
  const identifier = linearIdentifierOf(unit.attributes)
  const references: UnitReferences = {
    keys: unitKeys(unit.path, unit.attributes),
    linearWorkspace:
      unit.path.startsWith("linear/") && typeof url === "string"
        ? linearWorkspaceOfUrl(url)
        : null,
    teamKey: identifier ? (identifier.split("-")[0] ?? "") : null,
    urls: [],
    blobs: [],
    identifiers: [],
    pages: [],
  }
  const urls = extractUrls(unit.body)
  for (const url of urls) {
    // Text that only looks like a URL (a template or a placeholder host)
    // cannot name a unit: skip it with no warning (CTX-1088).
    if (!URL.canParse(url)) continue
    guarded("URL", () => {
      references.urls.push(...urlKeys(url))
      const blob = githubBlobPath(url)
      if (blob) references.blobs.push(blob)
    })
  }
  // An identifier inside a Linear link (its text or its URL) is the
  // link's, so the URL check decides it.
  const text = urls.reduce(
    (body, url) => body.replaceAll(url, " "),
    unit.body.replace(/\[[^\]]*\]\((https?:\/\/linear\.app\/[^)\s]*)\)/gi, " "),
  )
  // The match of `findLinearIdentifiers` for all team keys. The resolve
  // step keeps the identifiers of the known teams, which gives the same
  // result as a match for only those teams.
  const found = new Set<string>()
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{0,9})-(\d+)\b/gi)) {
    const candidate = normalizeLinearIdentifier(`${match[1]}-${match[2]}`)
    if (candidate) found.add(candidate)
  }
  references.identifiers = [...found]
  const dir = unit.path.split("/").slice(0, -1).join("/")
  for (const href of unit.links) {
    guarded("Confluence link", () => {
      const target = resolveLink(dir, href)
      const page = confluencePageIdOfPath(target)
      if (page)
        references.pages.push({
          path: target,
          key: confluencePageDedupKey(page),
        })
    })
  }
  return references
}

/**
 * `workspace:<path>` links for each unit: the URLs and the Linear
 * identifiers of known teams that name another unit of the Workspace. A
 * reference to a thing that the Workspace does not hold gives no link, so it
 * stays external. A relative Confluence link whose page moved resolves by
 * the page id.
 */
export function resolveReferenceLinks(input: {
  units: ReadonlyArray<{ path: string; references: UnitReferences }>
  workspaceUrl?: string
  /** Hosts of the org's Confluence connections. */
  confluenceSiteHosts?: ReadonlySet<string>
}): Map<string, string[]> {
  const paths = new Set(input.units.map((unit) => unit.path))
  const linearWorkspaces = new Set<string>()
  const teamKeys = new Set<string>()
  for (const { references } of input.units) {
    if (references.linearWorkspace)
      linearWorkspaces.add(references.linearWorkspace)
    if (references.teamKey !== null) teamKeys.add(references.teamKey)
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
  for (const unit of input.units) {
    for (const key of unit.references.keys) {
      if (!siteKeyCounts(key, sites)) continue
      const list = byKey.get(key.key) ?? []
      if (!list.includes(unit.path)) list.push(unit.path)
      byKey.set(key.key, list)
    }
  }
  if (byKey.size === 0 && !input.workspaceUrl) return new Map()
  const workspaceRepository = input.workspaceUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceUrl)
    : null

  const out = new Map<string, string[]>()
  for (const { path, references } of input.units) {
    const targets = new Set<string>()
    const addKey = (key: string) => {
      for (const target of byKey.get(key) ?? []) targets.add(target)
    }
    for (const key of references.urls)
      if (siteKeyCounts(key, sites)) addKey(key.key)
    for (const blob of references.blobs)
      if (blob.repository === workspaceRepository && paths.has(blob.path))
        targets.add(blob.path)
    for (const identifier of references.identifiers)
      if (teamKeys.has(identifier.split("-")[0] ?? ""))
        addKey(issueDedupKey(identifier))
    for (const page of references.pages)
      if (!paths.has(page.path)) addKey(page.key)
    targets.delete(path)
    if (targets.size > 0) {
      out.set(
        path,
        [...targets]
          .sort()
          .map((target) => `${WORKSPACE_LINK_SCHEME}${target}`),
      )
    }
  }
  return out
}
