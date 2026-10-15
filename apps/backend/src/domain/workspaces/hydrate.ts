import { createHash } from "node:crypto"
import { base32nopad } from "@scure/base"
import { connectorMirrorRoot } from "../codeIngestion/connectorMirrorPaths.js"
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import type {
  PreviousSourceRow,
  SourceFileBlob,
} from "../workspace-sources/projection-plan.js"
import { SOURCES_FOLDER_PREFIX } from "../workspace-sources/source-tree.js"
import { FROM_SOURCE_PREDICATE } from "./graph-relevance.js"
import { effectiveValidFrom } from "./hydrate-phases.js"
import { markdownLines } from "./knowledge-chunks.js"
import {
  isLinkedRepositoryDeclaration,
  parseSimpleFrontMatter,
} from "./layout.js"
import {
  mirrorUnitKind,
  referenceLinks,
  WORKSPACE_LINK_SCHEME,
} from "./mirror-units.js"
import { pullRequestChangedClaims } from "./pull-request-changes.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export function servingIdForKnowledgePath(
  workspaceId: string,
  path: string,
): string {
  const normalised = path.replace(/^\/+/, "").replaceAll("\\", "/")
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${normalised}`)
    .digest()
    .subarray(0, 16)
  return `kn_${base32nopad.encode(digest).toLowerCase()}`
}

export type HydrateClaim = {
  to: string
  predicate: string | null
  confidence: number | null
  validFrom: string | null
  validTo: string | null
  source: string | null
}

export type HydrateUnit = {
  path: string
  servingId: string
  /**
   * Front-matter `kind` (graph ontology), else the kind of a connector-mirror
   * path; absent for plain knowledge files.
   */
  kind?: string | null
  body: string
  links: string[]
  claims: HydrateClaim[]
  confidence?: number | null
  /** Front-matter `title`, else the text of the first Markdown heading. */
  title: string | null
  /** The connector root of a mirror path (`linear`, …), else `authored`. */
  source: string
  /** ISO time of the last commit that changed the path, when known. */
  updatedAt: string | null
  /** File line of the first body line, after front matter. Read from Git only. */
  bodyStartLine?: number
}

export const HYDRATE_SKIP_REASONS = [
  "malformed",
  "duplicate_repository",
] as const

export type HydrateSkip = {
  path: string
  reason: (typeof HYDRATE_SKIP_REASONS)[number]
}

const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g

/** One linked repository that the GitHub sources of a revision declare. */
export type HydrateLinkedRepository = {
  path: string
  git: string
  /** The branch or tag of the entry; null is the default branch. */
  branch: string | null
  /** The GitHub connection of the source entry. */
  connectionId: string
}

export function hydrateKnowledgeTree(input: {
  workspaceId: string
  /** The Workspace repository. A GitHub source that names it links nothing. */
  workspaceUrl?: string
  files: ReadonlyArray<{
    path: string
    content: string
    lastCommitTimestamp?: string
  }>
  /**
   * The text of `.ctxpipe/sources.yaml`, or null. Its GitHub sources and the
   * GitHub source files in `sourceFiles` are the only links of
   * the Workspace (ADR-050).
   */
  sourcesFile?: string | null
  /** Every blob under `sources/` (`splitSourcesTree`). Its GitHub sources link. */
  sourceFiles?: ReadonlyArray<SourceFileBlob>
  /** The org's GitHub connection ids. A source with another id links nothing. */
  githubConnectionIds?: ReadonlySet<string>
  /**
   * The source rows of the previous projected revision. They decide which
   * source links a repository that two sources name, as in the projection.
   */
  previousSourceRows?: ReadonlyArray<PreviousSourceRow>
  /**
   * Hosts of the org's Confluence connections. A Confluence URL on another
   * host makes no edge.
   */
  confluenceSiteHosts?: ReadonlySet<string>
}): {
  units: HydrateUnit[]
  skipped: HydrateSkip[]
  linked: HydrateLinkedRepository[]
} {
  const units: HydrateUnit[] = []
  const attributes = new Map<string, Record<string, unknown>>()
  const skipped: HydrateSkip[] = []
  const linked: HydrateLinkedRepository[] = []
  const seenLinked = new Set<string>(
    input.workspaceUrl
      ? [normalizeWorkspaceRepositoryUrl(input.workspaceUrl)]
      : [],
  )

  for (const file of input.files) {
    const path = file.path.replace(/^\/+/, "")
    // A `repositories/*.md` file links nothing since ADR-050 (the upgrade
    // moves it into the sources file), and it is not a knowledge unit.
    if (isLinkedRepositoryDeclaration(path)) continue
    if (!path.endsWith(".md")) continue
    if (path === "AGENTS.md" || path.startsWith(".agents/")) continue

    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) {
      skipped.push({ path, reason: "malformed" })
      continue
    }

    attributes.set(path, parsed.attributes)
    units.push({
      path,
      servingId: servingIdForKnowledgePath(input.workspaceId, path),
      // A source file has no `kind` key (ADR-050); its folder sets the kind.
      kind: path.startsWith(SOURCES_FOLDER_PREFIX)
        ? "Source"
        : typeof parsed.attributes.kind === "string" &&
            parsed.attributes.kind.trim()
          ? parsed.attributes.kind.trim()
          : mirrorUnitKind(path),
      body: parsed.body,
      links: markdownLinks(parsed.body),
      claims: parseClaims(parsed.attributes.claims),
      confidence: parseOptionalNumber(parsed.attributes.confidence),
      title: unitTitle(parsed.attributes.title, parsed.body),
      source: connectorMirrorRoot(path) ?? "authored",
      updatedAt: file.lastCommitTimestamp ?? null,
      bodyStartLine: file.content
        .slice(0, file.content.length - parsed.body.length)
        .split("\n").length,
    })
  }

  const references = referenceLinks({
    units: units.map((unit) => ({
      ...unit,
      attributes: attributes.get(unit.path) ?? {},
    })),
    workspaceUrl: input.workspaceUrl,
    confluenceSiteHosts: input.confluenceSiteHosts,
    resolveLink: resolveHydrateLink,
  })
  for (const unit of units) {
    const extra = references.get(unit.path)
    if (extra) unit.links.push(...extra)
  }
  // Each GitHub repository of the Workspace, from every connection. The
  // CHANGED lookup uses all of them; `linked` keeps the connected ones.
  const repositories = githubSourceRepositories(
    input.sourcesFile ?? null,
    null,
    input.sourceFiles,
    {
      previousRows: input.previousSourceRows,
      workspaceUrl: input.workspaceUrl,
    },
  )
  const changes = pullRequestChangedClaims(
    units.map((unit) => ({
      ...unit,
      attributes: attributes.get(unit.path) ?? {},
    })),
    new Map(
      repositories
        .filter((source) => source.path.startsWith(SOURCES_FOLDER_PREFIX))
        .map((source) => [source.path, source.gitUrl]),
    ),
  )
  for (const unit of units) unit.claims.push(...(changes.get(unit.path) ?? []))
  const sourcePaths = new Set(
    units
      .filter((unit) => unit.path.startsWith(SOURCES_FOLDER_PREFIX))
      .map((unit) => unit.path),
  )
  for (const unit of units) {
    unit.claims.push(
      ...fromSourceClaims(attributes.get(unit.path) ?? {}, sourcePaths),
    )
  }

  // A repository that an earlier entry or the Workspace names is not a skip.
  const connectionIds = input.githubConnectionIds ?? new Set()
  for (const source of repositories) {
    if (!connectionIds.has(source.connectionId)) continue
    if (seenLinked.has(source.gitUrl)) continue
    seenLinked.add(source.gitUrl)
    linked.push({
      path: source.path,
      git: source.gitUrl,
      branch: source.ref,
      connectionId: source.connectionId,
    })
  }

  return { units, skipped, linked }
}

/**
 * The source file path that one `sources` entry names (ADR-050), from the
 * Workspace root. A URL, another path or a value that is not text gives null.
 */
export function sourcePathOf(entry: unknown): string | null {
  if (typeof entry !== "string") return null
  const path = resolveHydrateLink("", entry.trim())
  return path.startsWith(SOURCES_FOLDER_PREFIX) ? path : null
}

/** The source file paths in the `sources` front matter of a unit. */
export function sourcePathsOf(attributes: Record<string, unknown>): string[] {
  const raw = attributes.sources
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => sourcePathOf(entry) ?? [])
}

/**
 * One `FROM_SOURCE` claim for each path in the `sources` front matter that
 * names a source file (ADR-050). A URL or another path makes no claim.
 */
function fromSourceClaims(
  attributes: Record<string, unknown>,
  sourcePaths: ReadonlySet<string>,
): HydrateClaim[] {
  const targets = new Set(
    sourcePathsOf(attributes).filter((path) => sourcePaths.has(path)),
  )
  return [...targets].map((path) => ({
    to: `${WORKSPACE_LINK_SCHEME}${path}`,
    predicate: FROM_SOURCE_PREDICATE,
    confidence: 1,
    validFrom: null,
    validTo: null,
    source: "git",
  }))
}

function unitTitle(frontMatterTitle: unknown, body: string): string | null {
  if (typeof frontMatterTitle === "string" && frontMatterTitle.trim())
    return frontMatterTitle.trim()
  return markdownLines(body).find((line) => line.heading)?.heading ?? null
}

export function shouldHydrateBeforeMigrationExport(
  migrationExportSha: string | null | undefined,
): boolean {
  return !migrationExportSha
}

export function applyEffectiveValidFromToUnits(
  units: readonly HydrateUnit[],
  introducingCommits: ReadonlyMap<string, string>,
): HydrateUnit[] {
  return units.map((unit) => ({
    ...unit,
    claims: unit.claims.map((claim) => ({
      ...claim,
      validFrom: effectiveValidFrom({
        recorded: claim.validFrom,
        introducingCommitTimestamp: introducingCommits.get(unit.path) ?? null,
      }),
    })),
  }))
}

export function hydrateUnitsToProjectionClaims(
  units: readonly HydrateUnit[],
  introducingCommitTimestamp?: string | null,
): Array<{
  id: string
  subjectId: string
  objectId: string
  subjectKind: string
  objectKind: string
  predicate: string
  status: string
  aggregatedConfidence: number
  sourceCount: number
  lastObservedAt: string
  validFrom: string | null
  validTo: string | null
  source: string | null
}> {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const claims: Array<{
    id: string
    subjectId: string
    objectId: string
    subjectKind: string
    objectKind: string
    predicate: string
    status: string
    aggregatedConfidence: number
    sourceCount: number
    lastObservedAt: string
    validFrom: string | null
    validTo: string | null
    source: string | null
  }> = []
  for (const unit of units) {
    const dir = unit.path.split("/").slice(0, -1).join("/")
    const bodyTargets = new Set(
      unit.links.map((href) => resolveHydrateLink(dir, href)),
    )
    for (const [index, claim] of unit.claims.entries()) {
      const target = resolveHydrateLink(dir, claim.to)
      // A predicate-less claim adds no second layer over the permanent body link.
      if (!claim.predicate && bodyTargets.has(target)) continue
      const object = byPath.get(target)
      if (!object) continue
      const validFrom = effectiveValidFrom({
        recorded: claim.validFrom,
        introducingCommitTimestamp: introducingCommitTimestamp ?? null,
      })
      claims.push({
        id: `${unit.servingId}:${index}`,
        subjectId: unit.servingId,
        objectId: object.servingId,
        subjectKind: "KnowledgeUnit",
        objectKind: "KnowledgeUnit",
        predicate: claim.predicate || "LINKS_TO",
        status: "active",
        aggregatedConfidence: claim.confidence ?? unit.confidence ?? 0.5,
        sourceCount: 1,
        lastObservedAt: validFrom ?? "1970-01-01T00:00:00.000Z",
        validFrom,
        validTo: claim.validTo,
        source: claim.source,
      })
    }
    const emittedBodyTargets = new Set<string>()
    for (const [index, href] of unit.links.entries()) {
      const target = resolveHydrateLink(dir, href)
      const object = byPath.get(target)
      if (!object) continue
      if (emittedBodyTargets.has(target)) continue
      emittedBodyTargets.add(target)
      claims.push({
        id: `${unit.servingId}:link:${index}`,
        subjectId: unit.servingId,
        objectId: object.servingId,
        subjectKind: "KnowledgeUnit",
        objectKind: "KnowledgeUnit",
        predicate: "LINKS_TO",
        status: "active",
        aggregatedConfidence: 1,
        sourceCount: 1,
        lastObservedAt: "1970-01-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
        source: "git",
      })
    }
  }
  return claims
}

export function resolveHydrateLink(fromDir: string, href: string): string {
  // Hydrate writes a resolved reference as `workspace:<path>`.
  if (href.startsWith(WORKSPACE_LINK_SCHEME)) {
    return href.slice(WORKSPACE_LINK_SCHEME.length)
  }
  const cleaned = href.split("#")[0] ?? href
  if (!cleaned || cleaned.startsWith("http:") || cleaned.startsWith("https:")) {
    return ""
  }
  const parts = (fromDir ? `${fromDir}/${cleaned}` : cleaned).split("/")
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") {
      resolved.pop()
      continue
    }
    resolved.push(part)
  }
  return resolved.join("/")
}

export function displayNameFromAgentsMarkdown(raw: string): string | null {
  const parsed = parseSimpleFrontMatter(raw)
  if (parsed.malformed) return null
  const name =
    typeof parsed.attributes.name === "string"
      ? parsed.attributes.name.trim()
      : ""
  return name || null
}

function parseOptionalNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function parseClaims(raw: unknown): HydrateClaim[] {
  if (!Array.isArray(raw)) return []
  const claims: HydrateClaim[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const to = typeof row.to === "string" ? row.to.trim() : ""
    if (!to) continue
    claims.push({
      to,
      predicate: typeof row.predicate === "string" ? row.predicate : null,
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      validFrom: typeof row.valid_from === "string" ? row.valid_from : null,
      validTo: typeof row.valid_to === "string" ? row.valid_to : null,
      source: typeof row.source === "string" ? row.source : null,
    })
  }
  return claims
}

function markdownLinks(body: string): string[] {
  const links: string[] = []
  for (const match of body.matchAll(MD_LINK)) {
    const href = match[2]?.trim()
    if (!href || href.startsWith("http:") || href.startsWith("https:")) continue
    if (href.startsWith("#")) continue
    links.push(href.split("#")[0] ?? href)
  }
  return links
}
