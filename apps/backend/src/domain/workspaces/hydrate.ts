import { createHash } from "node:crypto"

import { base32nopad } from "@scure/base"

import { connectorMirrorRoot } from "../codeIngestion/connectorMirrorPaths.js"
import { legacySourceUrlOfAttributes } from "../ingestion/ownership-migration.js"
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import type {
  PreviousSourceRow,
  SourceFileBlob,
} from "../workspace-sources/projection-plan.js"
import { SOURCES_FOLDER_PREFIX } from "../workspace-sources/source-tree.js"
import { FROM_SOURCE_PREDICATE } from "./graph-relevance.js"
import { effectiveValidFrom } from "./hydrate-phases.js"
import {
  needsClaimsUpgrade,
  needsValidFromPersist,
  importKeyCleanupFiles,
} from "./hydrate-write-jobs.js"
import { markdownLines } from "./knowledge-chunks.js"
import {
  isLinkedRepositoryDeclaration,
  parseSimpleFrontMatter,
} from "./layout.js"
import {
  extractUnitReferences,
  mirrorUnitKind,
  resolveReferenceLinks,
  type UnitReferences,
  WORKSPACE_LINK_SCHEME,
} from "./mirror-units.js"
import {
  extractChangeData,
  resolveChangedClaims,
  type UnitChangeData,
} from "./pull-request-changes.js"
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

/**
 * True when a claim of the `claims` front matter has an `evidence` mapping.
 * Each claim that the ingestion v2 schema accepts has one (CTX-1100).
 */
export function claimHasEvidence(claim: unknown): boolean {
  if (!claim || typeof claim !== "object") return false
  const { evidence } = claim as { evidence?: unknown }
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
  )
}

/**
 * The `source` of a unit that hydrate makes from the main-era knowledge in
 * Postgres, not from git. Such a unit is read-only.
 */
export const LEGACY_UNIT_SOURCE = "legacy"

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
  /** Front-matter `generated_by`: the owner of a generated file. */
  generatedBy?: string | null
  /** True when a claim of the `claims` front matter has no `evidence` mapping. */
  hasClaimWithoutEvidence?: boolean
  /** Front-matter `title`, else the text of the first Markdown heading. */
  title: string | null
  /** The connector root of a mirror path (`linear`, …), else `authored`. */
  source: string
  /** ISO time of the last commit that changed the path, when known. */
  updatedAt: string | null
  /** File line of the first body line, after front matter. Read from Git only. */
  bodyStartLine?: number
  /** The reference index of the unit. Read from Git only. */
  referenceIndex?: UnitReferenceIndex
}

export const HYDRATE_SKIP_REASONS = [
  "malformed",
  "duplicate_repository",
  "merge_conflict",
] as const

export type HydrateSkip = {
  path: string
  reason: (typeof HYDRATE_SKIP_REASONS)[number]
  /**
   * `legacy-overlay`: the file is not in Git. It is a read-only file that
   * hydrate builds from the database for knowledge from before Workspaces.
   */
  source?: "legacy-overlay"
}

/**
 * True when the text has a Git conflict, outside fenced code blocks: a
 * `<<<<<<< ` line, then a `=======` line, then a `>>>>>>> ` line.
 */
function hasConflictMarkers(content: string): boolean {
  let fence: { char: string; length: number } | null = null
  let stage = 0
  for (const line of content.split("\n")) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""))
    if (fence) {
      if (
        opening &&
        opening[1]?.[0] === fence.char &&
        opening[1].length >= fence.length &&
        opening[2]?.trim() === ""
      ) {
        fence = null
      }
      continue
    }
    if (opening && !(opening[1]?.[0] === "`" && opening[2]?.includes("`"))) {
      fence = { char: opening[1]?.[0] ?? "`", length: opening[1]?.length ?? 3 }
      continue
    }
    if (stage === 0 && /^<{7} /.test(line)) stage = 1
    else if (stage === 1 && /^={7}\r?$/.test(line)) stage = 2
    else if (stage === 2 && /^>{7} /.test(line)) return true
  }
  return false
}

const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g

/** One linked repository that the GitHub sources of a revision declare. */
type HydrateLinkedRepository = {
  path: string
  git: string
  /** The branch or tag of the entry; null is the default branch. */
  branch: string | null
  /** The GitHub connection of the source entry. */
  connectionId: string
}

/**
 * The facts of one knowledge file that the write planner counts
 * (`planHydrateWrites`). A file that hydrate skips has facts too: the
 * import key and ownership jobs read each file under `knowledge/`.
 */
export type KnowledgePlanFacts = {
  /** The claims upgrade job changes the file. */
  claimsUpgrade: boolean
  /** The valid_from job changes the file. */
  validFromPersist: boolean
  /** The import key cleanup job changes the file. */
  importKey: boolean
  /** The source repository URL that the ownership migration reads. */
  legacySourceUrl: string | null
}

/**
 * The version of each value that the parse of one file gives and that
 * hydrate stores: the row columns of the unit (kind, title, source, body,
 * the commit times) and each value of `UnitReferenceIndex`. A partial parse
 * keeps the stored row of each file that did not change, so it needs the
 * current version on each stored unit; else the hydrate parses all files
 * once. The unit hash holds this version too.
 *
 * Increase this number when the parse of one file gives another value for
 * the same file (`parseKnowledgeFile`, the history read that gives the
 * commit times), or when the shape of the index changes. A change in
 * `deriveKnowledgeUnits` (the links, the claims and the plan facts that
 * depend on other files) needs no new version: each hydrate computes those
 * values again for all units from the indexes.
 */
export const REFERENCE_INDEX_VERSION = 1

/**
 * The reference index of one unit. Hydrate stores it with the unit. It holds
 * each value of the unit that other files can change, before hydrate applies
 * the other files: the keys and the raw references (`UnitReferences`), the
 * data for the `CHANGED` claims, the `sources` paths, the body links and the
 * claims of the front matter. So a partial hydrate can compute the links and
 * the claims of all units from Postgres and the changed files only
 * (`deriveKnowledgeUnits`).
 */
export type UnitReferenceIndex = {
  version: number
  references: UnitReferences
  change: UnitChangeData
  /** The Markdown links of the body. */
  bodyLinks: string[]
  /** The claims of the front matter, with their recorded `valid_from`. */
  claims: HydrateClaim[]
  /** The source file paths of the `sources` front matter. */
  sources: string[]
  generatedBy: string | null
  hasClaimWithoutEvidence: boolean
  /** File line of the first body line, after front matter. */
  bodyStartLine: number
  /** ISO time of the newest commit that added the path, when known. */
  introducedAt: string | null
  plan: KnowledgePlanFacts
}

type KnowledgeFile = {
  path: string
  content: string
  lastCommitTimestamp?: string
  introducingCommitTimestamp?: string
}

/**
 * Parse one file of the tree: a unit with the values that depend only on
 * this file, a skip, or nothing (a file that is not knowledge).
 */
function parseKnowledgeFile(
  workspaceId: string,
  file: KnowledgeFile,
  workspaceUrl: string | null,
):
  | { unit: HydrateUnit & { referenceIndex: UnitReferenceIndex } }
  | { skip: HydrateSkip; facts: KnowledgePlanFacts }
  | null {
  const path = file.path.replace(/^\/+/, "")
  // A `repositories/*.md` file links nothing since ADR-050 (the upgrade
  // moves it into the sources file), and it is not a knowledge unit.
  if (isLinkedRepositoryDeclaration(path)) return null
  if (!path.endsWith(".md")) return null
  const facts = (
    attributes: Record<string, unknown> | null,
  ): KnowledgePlanFacts => ({
    claimsUpgrade: false,
    validFromPersist: false,
    importKey:
      attributes !== null &&
      Object.hasOwn(attributes, "import_key") &&
      path.startsWith("knowledge/") &&
      importKeyCleanupFiles([{ path, content: file.content }]).length > 0,
    legacySourceUrl:
      attributes && workspaceUrl && path.startsWith("knowledge/")
        ? legacySourceUrlOfAttributes(attributes, workspaceUrl)
        : null,
  })
  // The write workflow commits Git conflict markers when the model cannot
  // merge a Markdown file. Such a file holds two versions, so it is not
  // knowledge, and the user must see it.
  if (hasConflictMarkers(file.content)) {
    const parsed = parseSimpleFrontMatter(file.content)
    return {
      skip: { path, reason: "merge_conflict" },
      facts: facts(parsed.malformed ? null : parsed.attributes),
    }
  }
  if (path === "AGENTS.md" || path.startsWith(".agents/")) return null

  const parsed = parseSimpleFrontMatter(file.content)
  if (parsed.malformed) {
    return { skip: { path, reason: "malformed" }, facts: facts(null) }
  }
  const { attributes, body } = parsed
  // A source file has no `kind` key (ADR-050); its folder sets the kind.
  const kind = path.startsWith(SOURCES_FOLDER_PREFIX)
    ? "Source"
    : typeof attributes.kind === "string" && attributes.kind.trim()
      ? attributes.kind.trim()
      : mirrorUnitKind(path)
  const bodyLinks = markdownLinks(body)
  const claims = parseClaims(attributes.claims)
  const generatedBy =
    typeof attributes.generated_by === "string" ? attributes.generated_by : null
  const hasClaimWithoutEvidence =
    Array.isArray(attributes.claims) &&
    attributes.claims.some((claim) => !claimHasEvidence(claim))
  const bodyStartLine = file.content
    .slice(0, file.content.length - body.length)
    .split("\n").length
  return {
    unit: {
      path,
      servingId: servingIdForKnowledgePath(workspaceId, path),
      kind,
      body,
      links: [...bodyLinks],
      claims: [...claims],
      confidence: parseOptionalNumber(attributes.confidence),
      generatedBy,
      hasClaimWithoutEvidence,
      title: unitTitle(attributes.title, body),
      source: connectorMirrorRoot(path) ?? "authored",
      updatedAt: file.lastCommitTimestamp ?? null,
      bodyStartLine,
      referenceIndex: {
        version: REFERENCE_INDEX_VERSION,
        references: extractUnitReferences(
          { path, body, links: bodyLinks, attributes },
          resolveHydrateLink,
        ),
        change: extractChangeData({ kind, attributes }),
        bodyLinks,
        claims,
        sources: sourcePathsOf(attributes),
        generatedBy,
        hasClaimWithoutEvidence,
        bodyStartLine,
        introducedAt: file.introducingCommitTimestamp ?? null,
        plan: facts(attributes),
      },
    },
  }
}

/**
 * Parse the knowledge files of a tree, one file at a time. The result holds
 * no value that depends on another file: `deriveKnowledgeUnits` adds those.
 */
export function parseKnowledgeFiles(input: {
  workspaceId: string
  workspaceUrl?: string
  files: ReadonlyArray<KnowledgeFile>
}): {
  units: Array<HydrateUnit & { referenceIndex: UnitReferenceIndex }>
  skipped: HydrateSkip[]
  /** The plan facts of each skipped file. */
  skippedFacts: KnowledgePlanFacts[]
} {
  const units: Array<HydrateUnit & { referenceIndex: UnitReferenceIndex }> = []
  const skipped: HydrateSkip[] = []
  const skippedFacts: KnowledgePlanFacts[] = []
  const workspaceUrl = input.workspaceUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceUrl)
    : null
  for (const file of input.files) {
    const parsed = parseKnowledgeFile(input.workspaceId, file, workspaceUrl)
    if (!parsed) continue
    if ("unit" in parsed) units.push(parsed.unit)
    else {
      skipped.push(parsed.skip)
      skippedFacts.push(parsed.facts)
    }
  }
  return { units, skipped, skippedFacts }
}

/**
 * The values of each unit that depend on other files: the links (the body
 * links, then the resolved references), the claims (the front matter
 * claims, then `CHANGED`, then `FROM_SOURCE`), and the plan facts of the
 * claim jobs. The input is the reference index of each unit of the tree,
 * in tree order. A full hydrate and a partial hydrate both use this
 * function, so both give the same values.
 */
export function deriveKnowledgeUnits(input: {
  units: ReadonlyArray<{
    path: string
    referenceIndex: UnitReferenceIndex
  }>
  workspaceUrl?: string
  confluenceSiteHosts?: ReadonlySet<string>
  /** Path of each GitHub source file → its repository URL. */
  sourceRepositories: ReadonlyMap<string, string>
}): Map<
  string,
  {
    links: string[]
    claims: HydrateClaim[]
    plan: Pick<KnowledgePlanFacts, "claimsUpgrade" | "validFromPersist">
  }
> {
  const references = resolveReferenceLinks({
    units: input.units.map((unit) => ({
      path: unit.path,
      references: unit.referenceIndex.references,
    })),
    workspaceUrl: input.workspaceUrl,
    confluenceSiteHosts: input.confluenceSiteHosts,
  })
  const changes = resolveChangedClaims(
    input.units.map((unit) => ({
      path: unit.path,
      change: unit.referenceIndex.change,
    })),
    input.sourceRepositories,
  )
  const sourcePaths = new Set(
    input.units
      .filter((unit) => unit.path.startsWith(SOURCES_FOLDER_PREFIX))
      .map((unit) => unit.path),
  )
  const out = new Map<
    string,
    {
      links: string[]
      claims: HydrateClaim[]
      plan: Pick<KnowledgePlanFacts, "claimsUpgrade" | "validFromPersist">
    }
  >()
  for (const { path, referenceIndex: index } of input.units) {
    const links = [...index.bodyLinks, ...(references.get(path) ?? [])]
    const claims = [
      ...index.claims,
      ...(changes.get(path) ?? []),
      ...fromSourceClaims(index.sources, sourcePaths),
    ]
    out.set(path, {
      links,
      claims,
      plan: {
        claimsUpgrade: needsClaimsUpgrade({
          path,
          links,
          claims,
          generatedBy: index.generatedBy,
          hasClaimWithoutEvidence: index.hasClaimWithoutEvidence,
        }),
        validFromPersist: needsValidFromPersist({ claims }),
      },
    })
  }
  return out
}

/**
 * The GitHub repositories of the sources of a revision. The `CHANGED` lookup
 * uses all of them (path of each source file → its repository URL); `linked`
 * keeps the repositories of the org's connections.
 */
export function hydrateSourceRepositories(input: {
  workspaceUrl?: string
  sourcesFile?: string | null
  sourceFiles: ReadonlyArray<SourceFileBlob>
  githubConnectionIds?: ReadonlySet<string>
  previousSourceRows?: ReadonlyArray<PreviousSourceRow>
}): {
  sourceRepositories: Map<string, string>
  linked: HydrateLinkedRepository[]
} {
  const repositories = githubSourceRepositories(
    input.sourcesFile ?? null,
    null,
    input.sourceFiles,
    {
      previousRows: input.previousSourceRows,
      workspaceUrl: input.workspaceUrl,
    },
  )
  // A repository that an earlier entry or the Workspace names is not a skip.
  const seenLinked = new Set<string>(
    input.workspaceUrl
      ? [normalizeWorkspaceRepositoryUrl(input.workspaceUrl)]
      : [],
  )
  const linked: HydrateLinkedRepository[] = []
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
  return {
    sourceRepositories: new Map(
      repositories
        .filter((source) => source.path.startsWith(SOURCES_FOLDER_PREFIX))
        .map((source) => [source.path, source.gitUrl]),
    ),
    linked,
  }
}

/** The plan facts of each knowledge file of a parse, units first. */
export function knowledgePlanFacts(parsed: {
  units: ReadonlyArray<HydrateUnit>
  skippedFacts: readonly KnowledgePlanFacts[]
}): KnowledgePlanFacts[] {
  return [
    ...parsed.units.flatMap((unit) =>
      unit.referenceIndex ? [unit.referenceIndex.plan] : [],
    ),
    ...parsed.skippedFacts,
  ]
}

export function hydrateKnowledgeTree(input: {
  workspaceId: string
  /** The Workspace repository. A GitHub source that names it links nothing. */
  workspaceUrl?: string
  files: ReadonlyArray<KnowledgeFile>
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
  skippedFacts: KnowledgePlanFacts[]
  linked: HydrateLinkedRepository[]
} {
  const { units, skipped, skippedFacts } = parseKnowledgeFiles(input)
  const { sourceRepositories, linked } = hydrateSourceRepositories({
    ...input,
    sourceFiles:
      input.sourceFiles ??
      input.files
        .filter((file) => file.path.startsWith(SOURCES_FOLDER_PREFIX))
        .map((file) => ({ path: file.path, text: file.content })),
  })
  const derived = deriveKnowledgeUnits({
    units,
    workspaceUrl: input.workspaceUrl,
    confluenceSiteHosts: input.confluenceSiteHosts,
    sourceRepositories,
  })
  for (const unit of units) {
    const values = derived.get(unit.path)
    if (!values) continue
    unit.links = values.links
    unit.claims = values.claims
    unit.referenceIndex.plan = { ...unit.referenceIndex.plan, ...values.plan }
  }
  return { units, skipped, skippedFacts, linked }
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
function sourcePathsOf(attributes: Record<string, unknown>): string[] {
  const raw = attributes.sources
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => sourcePathOf(entry) ?? [])
}

/**
 * One `FROM_SOURCE` claim for each path in the `sources` front matter that
 * names a source file (ADR-050). A URL or another path makes no claim.
 */
function fromSourceClaims(
  paths: readonly string[],
  sourcePaths: ReadonlySet<string>,
): HydrateClaim[] {
  const targets = new Set(paths.filter((path) => sourcePaths.has(path)))
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
