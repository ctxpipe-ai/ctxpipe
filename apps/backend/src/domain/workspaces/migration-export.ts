import { createHash } from "node:crypto"

import { isAlias, isMap, isSeq, stringify as stringifyYaml } from "yaml"

import { SourceChangeError } from "../workspace-sources/edit.js"
import { linkGithubRepositories } from "../workspace-sources/github-links.js"
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import {
  assignImportedRepository,
  classifyUnkeyedKnowledgeCollision,
  mergeImportedClaims,
  nextKnowledgeUnitPath,
  shouldExportClaim,
  unkeyedCollisionExcerpt,
} from "./dest-workspace-first.js"
import { isHostOnlyPath } from "./host-only.js"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  removeMetadataKey,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import {
  greenfieldKnowledgePath,
  isLinkedRepositoryDeclaration,
  knowledgeAreaFromObjectKind,
  parseLinkedRepositoryMarkdown,
  parseSimpleFrontMatter,
} from "./layout.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { normalizeSlug, normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * The org repositories (the legacy `repositories` table) that the migration
 * links into a Workspace: only the first Workspace of the org links them,
 * and a repository that is the repository of a Workspace is not linked.
 */
export function migrationLinkedRepositoryUrls(input: {
  workspaceId: string
  firstWorkspaceId: string | null
  repositories: ReadonlyArray<{ id: string; gitUrl: string }>
  workspaceByRepositoryId: ReadonlyMap<string, string>
}): string[] {
  if (input.workspaceId !== input.firstWorkspaceId) return []
  return input.repositories
    .filter((repository) => !input.workspaceByRepositoryId.has(repository.id))
    .map((repository) => repository.gitUrl)
}

/**
 * Link GitHub repositories through `.ctxpipe/sources.yaml` (ADR-050): add
 * each repository that no GitHub source of the file links, with its `ref`
 * when it has one, to the GitHub source of `connectionId`
 * (`linked-repositories` first, or a new `linked-repositories` entry). It
 * returns the new file text, or null when the file already links each
 * repository, when no URL is a GitHub repository, or when the file is not a
 * valid version 1 file.
 */
export function migrationSourcesFile(input: {
  sourcesFile: string | null
  connectionId: string
  repositories: Iterable<{ gitUrl: string; ref?: string | null }>
}): string | null {
  const wanted: Array<{ name: string; ref: string | null }> = []
  for (const { gitUrl, ref } of input.repositories) {
    const name = githubRepoFullNameFromWorkspaceUrl(gitUrl)
    if (name) wanted.push({ name, ref: ref ?? null })
  }
  if (!wanted.length) return null
  try {
    return linkGithubRepositories({
      sourcesFile: input.sourcesFile,
      connectionId: input.connectionId,
      repositories: wanted,
    })
  } catch (error) {
    if (error instanceof SourceChangeError) return null
    throw error
  }
}

/**
 * Move the `repositories/*.md` files and the org repositories into the
 * GitHub sources of `.ctxpipe/sources.yaml` (ADR-050). A file links under
 * the GitHub connection of the Workspace (`connectionId`). An org repository
 * links under its own GitHub connection. A file goes away only when the new
 * file links its repository with the same ref. `sourcesFile` is the new text,
 * or null when the text does not change. `skipped` tells why a file or a URL
 * stays out of the sources file. `invalid` is true when the sources file is
 * not a valid version 1 file: then nothing is linked, and `skipped` names
 * each GitHub item. Running it again on its own result changes nothing.
 */
export function upgradeLinkedRepositories(input: {
  sourcesFile: string | null
  connectionId: string | null
  files: ReadonlyArray<{ path: string; content: string }>
  repositories?: ReadonlyArray<{
    gitUrl: string
    ref?: string | null
    connectionId: string | null
  }>
}): {
  sourcesFile: string | null
  deletePaths: string[]
  skipped: Array<{ item: string; reason: string }>
  invalid: boolean
} {
  const onlyGithub = "ctxpipe links only GitHub repositories"
  const skips = new Map<string, string>()
  const moved: Array<{ path: string; gitUrl: string; ref: string | null }> = []
  const byConnection = new Map<
    string,
    Array<{ item: string; gitUrl: string; ref: string | null }>
  >()
  const link = (
    connectionId: string | null,
    item: string,
    gitUrl: string,
    ref: string | null,
    noConnection: string,
  ) => {
    if (!connectionId) {
      skips.set(item, noConnection)
      return
    }
    const group = byConnection.get(connectionId) ?? []
    group.push({ item, gitUrl, ref })
    byConnection.set(connectionId, group)
  }
  for (const file of input.files) {
    if (!isLinkedRepositoryDeclaration(file.path)) continue
    const parsed = parseLinkedRepositoryMarkdown(file.content)
    if (parsed.malformed) {
      skips.set(file.path, "The file cannot be read as a linked repository")
      continue
    }
    const gitUrl = normalizeWorkspaceRepositoryUrl(parsed.git)
    if (!githubRepoFullNameFromWorkspaceUrl(gitUrl)) {
      skips.set(file.path, onlyGithub)
      continue
    }
    moved.push({ path: file.path, gitUrl, ref: parsed.branch })
    link(
      input.connectionId,
      file.path,
      gitUrl,
      parsed.branch,
      "The Workspace has no GitHub connection",
    )
  }
  for (const repository of input.repositories ?? []) {
    if (!githubRepoFullNameFromWorkspaceUrl(repository.gitUrl)) {
      skips.set(repository.gitUrl, onlyGithub)
      continue
    }
    link(
      repository.connectionId,
      repository.gitUrl,
      repository.gitUrl,
      repository.ref ?? null,
      "The repository has no GitHub connection",
    )
  }
  let text = input.sourcesFile
  let invalid: string | null = null
  try {
    for (const [connectionId, group] of byConnection) {
      const wanted = group.flatMap(({ gitUrl, ref }) => {
        const name = githubRepoFullNameFromWorkspaceUrl(gitUrl)
        return name ? [{ name, ref }] : []
      })
      text =
        linkGithubRepositories({
          sourcesFile: text,
          connectionId,
          repositories: wanted,
        }) ?? text
    }
  } catch (error) {
    if (!(error instanceof SourceChangeError)) throw error
    invalid = `\`.ctxpipe/sources.yaml\` is not a valid version 1 file (${error.message})`
  }
  const deletePaths: string[] = []
  if (invalid) {
    for (const group of byConnection.values())
      for (const { item } of group) skips.set(item, invalid)
  } else {
    const linkedRefs = new Map(
      githubSourceRepositories(text, null).map((linked) => [
        linked.gitUrl,
        linked.ref,
      ]),
    )
    for (const file of moved) {
      if (skips.has(file.path) || !linkedRefs.has(file.gitUrl)) continue
      const ref = linkedRefs.get(file.gitUrl) ?? null
      if (ref === file.ref) deletePaths.push(file.path)
      else
        skips.set(
          file.path,
          `The repository is linked with ${ref ? `ref ${ref}` : "no ref"}, but the file asks for ${file.ref ? `ref ${file.ref}` : "no ref"}`,
        )
    }
  }
  const order = [
    ...input.files.map((file) => file.path),
    ...(input.repositories ?? []).map(({ gitUrl }) => gitUrl),
  ]
  return {
    sourcesFile: invalid || text === input.sourcesFile ? null : text,
    deletePaths,
    skipped: [...new Set(order)].flatMap((item) => {
      const reason = skips.get(item)
      return reason ? [{ item, reason }] : []
    }),
    invalid: invalid !== null,
  }
}

export function importKeyFromDedup(
  deduplicationKey: string | null,
): string | null {
  const key = deduplicationKey?.trim()
  return key ? key : null
}

type ImportedMarkdownClaim = {
  to: string
  predicate: string
  confidence?: number
  validFrom?: string | null
  validTo?: string | null
  source?: string | null
}

export function importedObjectMarkdown(input: {
  title: string
  body: string
  importKey?: string | null
  kind?: string | null
  confidence?: number | null
  generatedBy?: string | null
  source?: string | null
  claims?: ReadonlyArray<ImportedMarkdownClaim>
}): string {
  return importedFrontMatter({
    importKey: input.importKey,
    kind: input.kind,
    confidence: input.confidence,
    generatedBy:
      input.generatedBy === undefined ? "ctxpipe" : input.generatedBy,
    source: input.source,
    claims: input.claims,
    body: `# ${input.title}\n\n${input.body.trim()}`,
  })
}

function mergeExistingImportedMarkdown(
  original: string,
  input: Omit<Parameters<typeof importedFrontMatter>[0], "body"> & {
    body?: string
  },
  claimIdentity?: (claim: ImportedMarkdownClaim) => string,
): string {
  const metadata = importedAttributes(input)
  const header = original.match(
    /^(\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*)(?=\r?\n|$)/,
  )?.[0]
  const newline = original.includes("\r\n") ? "\r\n" : "\n"
  const withBody =
    input.body === undefined
      ? original
      : header
        ? `${header}${newline}${newline}${input.body.trim()}${newline}`
        : input.body
  return updateKnowledgeMetadata(withBody, (document) => {
    if (input.importKey === null) removeMetadataKey(document, "import_key")
    for (const [key, value] of Object.entries(metadata)) {
      if (key !== "claims") {
        document.set(key, value)
        continue
      }
      if (!Array.isArray(value)) continue
      let claims = editableMetadataNode(document, "claims")
      if (!isSeq(claims)) {
        if (claims != null)
          throw new Error("Cannot merge malformed knowledge claims")
        document.set("claims", document.createNode([]))
        claims = document.get("claims", true)
      }
      if (!isSeq(claims)) throw new Error("Knowledge claims must be a sequence")
      for (const incoming of value) {
        const index = claims.items.findIndex((node) => {
          const candidate = isAlias(node) ? node.resolve(document) : node
          if (!isMap(candidate)) return false
          const to = candidate.get("to")
          const predicate = candidate.get("predicate")
          const source = candidate.get("source")
          if (typeof to !== "string" || typeof predicate !== "string")
            return false
          return claimIdentity
            ? claimIdentity({
                to,
                predicate,
                source: typeof source === "string" ? source : null,
              }) === claimIdentity(incoming)
            : to === incoming.to && predicate === incoming.predicate
        })
        if (index < 0) {
          claims.add(document.createNode(incoming))
          continue
        }
        let claim = claims.items[index]
        if (isAlias(claim)) {
          const detached = materializeMetadataAlias(document, claim)
          claims.items[index] = detached
          claim = detached
        }
        if (isMap(claim))
          for (const [field, next] of Object.entries(incoming))
            claim.set(field, next)
      }
    }
  })
}

type ImportedAttributesInput = {
  importKey?: string | null
  kind?: string | null
  confidence?: number | null
  generatedBy?: string | null
  source?: string | null
  claims?: ReadonlyArray<ImportedMarkdownClaim>
}

function importedAttributes(
  input: ImportedAttributesInput,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  if (input.importKey) attributes.import_key = input.importKey
  if (input.kind) attributes.kind = input.kind
  if (input.confidence != null) {
    attributes.confidence = clampedConfidence(input.confidence)
  }
  if (input.generatedBy) attributes.generated_by = input.generatedBy
  if (input.source) attributes.source = input.source
  if (input.claims && input.claims.length > 0) {
    attributes.claims = input.claims.map((claim) => ({
      to: claim.to,
      predicate: claim.predicate,
      ...(claim.confidence != null
        ? { confidence: clampedConfidence(claim.confidence) }
        : {}),
      ...(claim.validFrom ? { valid_from: claim.validFrom } : {}),
      ...(claim.validTo ? { valid_to: claim.validTo } : {}),
      ...(claim.source ? { source: claim.source } : {}),
    }))
  }
  return attributes
}

function importedFrontMatter(
  input: ImportedAttributesInput & { body: string },
): string {
  const attributes = importedAttributes(input)
  // The yaml library quotes every value that needs it, so the file always
  // parses. Quoted scalars (no block scalars) keep a trailing space and a
  // whitespace-only line, which `parseSimpleFrontMatter` would trim.
  const header =
    Object.keys(attributes).length > 0
      ? [
          "---",
          stringifyYaml(attributes, {
            lineWidth: 0,
            blockQuote: false,
          }).trimEnd(),
          "---",
        ]
      : ["---", "---"]
  return [...header, "", input.body.trim(), ""].join("\n")
}

function clampedConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Number(Math.min(1, Math.max(0, value)).toFixed(6))
}

const DEDUP_REPO_PREFIX = /^[^:]+:([^:]+):/

export function repositoryIdFromDedup(
  deduplicationKey: string | null | undefined,
): string | null {
  const key = deduplicationKey?.trim()
  if (!key) return null
  const match = key.match(DEDUP_REPO_PREFIX)
  const id = match?.[1]?.trim()
  return id || null
}

export function importKeyForExportedObject(object: {
  id: string
  deduplicationKey: string | null
  payload: unknown
}): string {
  const key = importKeyFromDedup(object.deduplicationKey)
  if (key && !/obj_/i.test(key)) return key
  const title = objectTitleFromPayload(object.payload)
  const summary = objectSummaryFromPayload(object.payload)
  const digest = createHash("sha256")
    .update(`${title}\0${summary}`)
    .digest("hex")
    .slice(0, 16)
  return `src:${digest}`
}

export function objectTitleFromPayload(payload: unknown): string {
  return payloadString(payload, "title", "name") || "Imported"
}

function objectSummaryFromPayload(payload: unknown): string {
  return payloadString(payload, "summary")
}

function objectConfidenceFromPayload(payload: unknown): number | null {
  return payloadNumber(payload, "confidence")
}

export function objectPathFromPayload(payload: unknown): string | null {
  const path = payloadString(
    payload,
    "path",
    "sourcePath",
    "source_path",
    "filePath",
    "file_path",
  )
  return path || null
}

function objectBodyFromPayload(payload: unknown, title?: string): string {
  const heading = title ?? objectTitleFromPayload(payload)
  const sections: string[] = []
  const summary = objectSummaryFromPayload(payload)
  if (summary && summary !== heading) sections.push(summary)
  const intent = payloadString(payload, "intent")
  if (intent) sections.push(`Intent: ${intent}`)
  const path = objectPathFromPayload(payload)
  if (path) sections.push(`Source: \`${path}\``)
  const method = payloadString(payload, "method")
  const apiPath = payloadString(payload, "apiPath", "api_path")
  if (method || apiPath) {
    sections.push(`API: ${[method, apiPath].filter(Boolean).join(" ")}`)
  }
  const category = payloadString(payload, "category")
  if (category) sections.push(`Category: ${category}`)
  const applicability = payloadString(payload, "applicability")
  if (applicability) sections.push(`Applicability: ${applicability}`)
  const modality = payloadString(payload, "modality")
  if (modality) sections.push(`Modality: ${modality}`)
  const excerpt = payloadString(payload, "sourceExcerpt", "source_excerpt")
  if (excerpt) {
    sections.push(
      excerpt
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    )
  }
  return sections.join("\n\n")
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null
  return payload as Record<string, unknown>
}

function payloadString(payload: unknown, ...keys: string[]): string {
  const record = payloadRecord(payload)
  if (!record) return ""
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function payloadNumber(payload: unknown, key: string): number | null {
  const value = payloadRecord(payload)?.[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  return null
}

export function isoDate(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString()
  }
  const trimmed = value.trim()
  return trimmed || null
}

export type ExportObjectRow = {
  id: string
  kind: string
  deduplicationKey: string | null
  payload: unknown
}

export type ExportClaimRow = {
  subjectId: string
  objectId: string
  predicate: string
  aggregatedConfidence: number
  validFrom: Date | string | null
  validTo: Date | string | null
  source?: string | null
  evidenceKey?: string | null
}

export type ExistingKnowledgeFile = {
  path: string
  content: string
}

export function workspaceByRepositoryUrl(input: {
  repositories: ReadonlyArray<{ id: string; gitUrl: string }>
  workspaces: ReadonlyArray<{ id: string; workspaceRepositoryUrl: string }>
  normalizeUrl: (url: string) => string
}): Map<string, string> {
  const workspaceByUrl = new Map<string, string>()
  for (const workspace of input.workspaces) {
    const url = input.normalizeUrl(workspace.workspaceRepositoryUrl)
    if (url) workspaceByUrl.set(url, workspace.id)
  }
  const result = new Map<string, string>()
  for (const repo of input.repositories) {
    const url = input.normalizeUrl(repo.gitUrl)
    const workspaceId = workspaceByUrl.get(url)
    if (workspaceId) result.set(repo.id, workspaceId)
  }
  return result
}

function importKeyFromExisting(content: string): string | null {
  const parsed = parseSimpleFrontMatter(content)
  if (parsed.malformed) return null
  const key = parsed.attributes.import_key
  return typeof key === "string" && key.trim() ? key.trim() : null
}

function claimsFromExisting(content: string): Array<{
  to: string
  predicate: string
  confidence?: number
  validFrom?: string | null
  validTo?: string | null
  source?: string | null
  body?: string
}> {
  const parsed = parseSimpleFrontMatter(content)
  if (parsed.malformed || !Array.isArray(parsed.attributes.claims)) return []
  const claims: Array<{
    to: string
    predicate: string
    confidence?: number
    validFrom?: string | null
    validTo?: string | null
    source?: string | null
    body?: string
  }> = []
  for (const item of parsed.attributes.claims) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const to = typeof row.to === "string" ? row.to.trim() : ""
    const predicate =
      typeof row.predicate === "string" ? row.predicate.trim() : ""
    if (!to || !predicate) continue
    claims.push({
      to,
      predicate,
      confidence:
        typeof row.confidence === "number" ? row.confidence : undefined,
      validFrom:
        typeof row.valid_from === "string" ? row.valid_from : undefined,
      validTo: typeof row.valid_to === "string" ? row.valid_to : undefined,
      source: typeof row.source === "string" ? row.source : undefined,
    })
  }
  return claims
}

export async function planKnowledgeProjection(input: {
  workspaceId: string
  firstWorkspaceId: string | null
  workspaceByRepositoryId: ReadonlyMap<string, string>
  objects: readonly ExportObjectRow[]
  claims: readonly ExportClaimRow[]
  existingKnowledge: readonly ExistingKnowledgeFile[]
  workspaceRepositoryUrl?: string | null
  repositoryGitUrlById?: ReadonlyMap<string, string>
  knownKnowledgePaths?: Readonly<Record<string, string>>
  referencePaths?: ReadonlyMap<string, string>
  claimIdentity?: (fromPath: string, claim: ImportedMarkdownClaim) => string
  stampImportKey?: boolean
  classifyUnkeyed?: (prompt: string) => Promise<string>
  /**
   * The objects that get a file. The default is every assigned object. A
   * link to an assigned object with no file goes to the file that has its
   * import key, or to the tree path of `resolveUnwritten`. Otherwise the
   * link is in `droppedLinks`.
   */
  writeObjectIds?: ReadonlySet<string>
  resolveUnwritten?: (object: ExportObjectRow) => string | null
}): Promise<{
  files: Array<{ path: string; content: string }>
  wouldChange: boolean
  knowledgePaths: Record<string, string>
  /** The links of a written object that the export cannot keep. */
  droppedLinks: Array<{
    from: ExportObjectRow
    predicate: string
    to: ExportObjectRow | null
  }>
}> {
  const claimIdentity = input.claimIdentity
  const objectWorkspace = new Map(
    [...(input.referencePaths?.keys() ?? [])].map((id) => [
      id,
      input.workspaceId,
    ]),
  )
  const assigned: ExportObjectRow[] = []
  for (const object of input.objects) {
    const assignment = assignImportedRepository({
      repositoryId: repositoryIdFromDedup(object.deduplicationKey),
      workspaceByRepositoryId: input.workspaceByRepositoryId,
      firstWorkspaceId: input.firstWorkspaceId,
    })
    if ("skip" in assignment) continue
    objectWorkspace.set(object.id, assignment.workspaceId)
    if (assignment.workspaceId === input.workspaceId) assigned.push(object)
  }
  const written = input.writeObjectIds
    ? assigned.filter((object) => input.writeObjectIds?.has(object.id))
    : assigned
  const objectById = new Map(input.objects.map((object) => [object.id, object]))

  const existingByImportKey = new Map<string, ExistingKnowledgeFile>()
  const existingByPath = new Map(
    input.existingKnowledge.map((file) => [file.path, file]),
  )
  const taken = new Set<string>()
  const claimedUnkeyed = new Set<string>()
  for (const file of input.existingKnowledge) {
    taken.add(file.path)
    const key = importKeyFromExisting(file.content)
    // An import key cannot route a write into a host-only path (CTX-722).
    if (key && !isHostOnlyPath(file.path) && !existingByImportKey.has(key))
      existingByImportKey.set(key, file)
  }

  const stampImportKey = input.stampImportKey !== false
  const existingPaths = new Set(
    input.existingKnowledge.map((file) => file.path),
  )
  const sourceContext = {
    workspaceRepositoryUrl: input.workspaceRepositoryUrl ?? null,
    repositoryGitUrlById: input.repositoryGitUrlById ?? new Map(),
    existingPaths,
  }
  const pathByObjectId = new Map(input.referencePaths)
  const titleByObjectId = new Map<string, string>()
  const bodyByObjectId = new Map<string, string>()
  const mergeFromByObjectId = new Map<string, ExistingKnowledgeFile>()
  const claimsByPath = new Map<
    string,
    Array<{
      to: string
      predicate: string
      confidence?: number
      validFrom?: string | null
      validTo?: string | null
      source?: string | null
      body?: string
    }>
  >()

  for (const object of written) {
    const importKey = importKeyForExportedObject(object)
    const title = objectTitleFromPayload(object.payload)
    const importedBody = objectBodyFromPayload(object.payload, title)
    const keyed = existingByImportKey.get(importKey)
    const preferred = greenfieldKnowledgePath(
      knowledgeAreaFromObjectKind(object.kind),
      normalizeSlug(title),
    )
    const pathIdentity =
      !keyed && !stampImportKey
        ? pathIdentityOccupant({
            preferred: input.knownKnowledgePaths?.[importKey] ?? preferred,
            existingByPath,
            claimedUnkeyed,
          })
        : null
    const allocated = keyed
      ? { path: keyed.path, mergeFrom: keyed, keyed: true }
      : pathIdentity
        ? { path: pathIdentity.path, mergeFrom: pathIdentity, keyed: true }
        : {
            ...(await allocateUnkeyedKnowledgePath({
              area: knowledgeAreaFromObjectKind(object.kind),
              slug: normalizeSlug(title),
              incomingBody: importedBody,
              taken,
              existingByPath,
              claimedUnkeyed,
              classifyUnkeyed: input.classifyUnkeyed,
            })),
            keyed: false,
          }
    const path = allocated.path
    taken.add(path)
    pathByObjectId.set(object.id, path)
    titleByObjectId.set(object.id, title)
    const occupant = allocated.mergeFrom
    if (occupant) mergeFromByObjectId.set(object.id, occupant)
    if (occupant) {
      const parsed = parseSimpleFrontMatter(occupant.content)
      const existingBody = parsed.malformed ? occupant.content : parsed.body
      bodyByObjectId.set(
        object.id,
        appendImportedBody(existingBody, importedBody),
      )
      claimsByPath.set(path, claimsFromExisting(occupant.content))
    } else {
      bodyByObjectId.set(object.id, importedBody)
      claimsByPath.set(path, [])
    }
  }

  for (const path of input.referencePaths?.values() ?? []) {
    const existing = existingByPath.get(path)
    if (existing && !claimsByPath.has(path))
      claimsByPath.set(path, claimsFromExisting(existing.content))
  }
  // A link target with no file of its own: the file with its import key,
  // or a tree path that hydrate reads (for example a connector file).
  const writtenIds = new Set(written.map((object) => object.id))
  for (const object of assigned) {
    if (writtenIds.has(object.id) || pathByObjectId.has(object.id)) continue
    const path =
      existingByImportKey.get(importKeyForExportedObject(object))?.path ??
      input.resolveUnwritten?.(object) ??
      null
    if (!path) continue
    pathByObjectId.set(object.id, path)
    titleByObjectId.set(object.id, objectTitleFromPayload(object.payload))
  }
  const droppedLinks: Array<{
    from: ExportObjectRow
    predicate: string
    to: ExportObjectRow | null
  }> = []
  const claimSubjectPaths = new Set<string>()
  for (const claim of input.claims) {
    if (objectWorkspace.get(claim.subjectId) !== input.workspaceId) continue
    if (
      input.writeObjectIds &&
      !writtenIds.has(claim.subjectId) &&
      !input.referencePaths?.has(claim.subjectId)
    )
      continue
    const fromPath = pathByObjectId.get(claim.subjectId)
    const toPath = shouldExportClaim({
      fromWorkspaceId: input.workspaceId,
      toWorkspaceId: objectWorkspace.get(claim.objectId) ?? null,
    })
      ? pathByObjectId.get(claim.objectId)
      : undefined
    if (!fromPath || !toPath) {
      const from = objectById.get(claim.subjectId)
      if (fromPath && from)
        droppedLinks.push({
          from,
          predicate: claim.predicate,
          to: objectById.get(claim.objectId) ?? null,
        })
      continue
    }
    claimSubjectPaths.add(fromPath)
    const subject = assigned.find((object) => object.id === claim.subjectId)
    const current = claimsByPath.get(fromPath) ?? []
    const incoming = {
      to: relativeKnowledgeLink(fromPath, toPath),
      predicate: claim.predicate,
      confidence: claim.aggregatedConfidence,
      validFrom: isoDate(claim.validFrom),
      validTo: isoDate(claim.validTo),
      source: resolveImportedSource({
        knowledgePath: fromPath,
        payload: subject?.payload,
        objectDedupKey: subject?.deduplicationKey,
        evidenceKey: claim.evidenceKey,
        recordedSource: claim.source,
        ...sourceContext,
      }),
      body: bodyByObjectId.get(claim.subjectId),
    }
    claimsByPath.set(
      fromPath,
      mergeImportedClaims(
        current,
        [incoming],
        claimIdentity ? (claim) => claimIdentity(fromPath, claim) : undefined,
      ),
    )
  }

  const files: Array<{ path: string; content: string }> = []
  for (const object of written) {
    const path = pathByObjectId.get(object.id)
    if (!path) continue
    const importKey = stampImportKey ? importKeyForExportedObject(object) : null
    const title = titleByObjectId.get(object.id) ?? "Imported"
    const claims = claimsByPath.get(path) ?? []
    const body = appendClaimSeeAlsoLinks(
      bodyByObjectId.get(object.id) ?? "",
      path,
      claims,
      titleByObjectId,
      pathByObjectId,
    )
    const fileSource = resolveImportedSource({
      knowledgePath: path,
      payload: object.payload,
      objectDedupKey: object.deduplicationKey,
      ...sourceContext,
    })
    const front = {
      importKey,
      kind: object.kind,
      confidence: objectConfidenceFromPayload(object.payload),
      generatedBy: "ctxpipe" as const,
      source: fileSource,
      claims,
    }
    const occupant = mergeFromByObjectId.get(object.id)
    files.push({
      path,
      content: occupant
        ? mergeExistingImportedMarkdown(
            occupant.content,
            { ...front, body },
            claimIdentity ? (claim) => claimIdentity(path, claim) : undefined,
          )
        : importedObjectMarkdown({
            ...front,
            title,
            body,
          }),
    })
  }
  const renderedPaths = new Set(files.map((file) => file.path))
  for (const path of claimSubjectPaths) {
    if (renderedPaths.has(path)) continue
    const existing = existingByPath.get(path)
    if (!existing) continue
    const parsed = parseSimpleFrontMatter(existing.content)
    if (parsed.malformed) continue
    files.push({
      path,
      content: mergeExistingImportedMarkdown(
        existing.content,
        {
          claims: claimsByPath.get(path),
        },
        claimIdentity ? (claim) => claimIdentity(path, claim) : undefined,
      ),
    })
  }
  const contentByPath = new Map(
    input.existingKnowledge.map((file) => [file.path, file.content]),
  )
  return {
    files,
    droppedLinks,
    knowledgePaths: Object.fromEntries(
      written.flatMap((object) => {
        const path = pathByObjectId.get(object.id)
        return path ? [[importKeyForExportedObject(object), path]] : []
      }),
    ),
    wouldChange: files.some(
      (file) => contentByPath.get(file.path) !== file.content,
    ),
  }
}

async function allocateUnkeyedKnowledgePath(input: {
  area: string
  slug: string
  incomingBody: string
  taken: Set<string>
  existingByPath: ReadonlyMap<string, ExistingKnowledgeFile>
  claimedUnkeyed: Set<string>
  classifyUnkeyed?: (prompt: string) => Promise<string>
}): Promise<{ path: string; mergeFrom: ExistingKnowledgeFile | null }> {
  const preferred = greenfieldKnowledgePath(input.area, input.slug)
  const occupant = input.existingByPath.get(preferred)
  if (
    occupant &&
    !importKeyFromExisting(occupant.content) &&
    !input.claimedUnkeyed.has(preferred)
  ) {
    const decision = await classifyUnkeyedKnowledgeCollision({
      existingPath: occupant.path,
      incomingPath: preferred,
      existingExcerpt: unkeyedCollisionExcerpt(occupant.content),
      incomingExcerpt: unkeyedCollisionExcerpt(input.incomingBody),
      classify: input.classifyUnkeyed,
    })
    if (decision === "merge") {
      input.claimedUnkeyed.add(preferred)
      return { path: preferred, mergeFrom: occupant }
    }
  }
  return {
    path: nextKnowledgeUnitPath(input.area, input.slug, input.taken),
    mergeFrom: null,
  }
}

function appendImportedBody(existing: string, incoming: string): string {
  const current = existing.trim()
  const next = incoming.trim()
  if (!next) return current
  if (!current) return next
  if (current.includes(next)) return current
  return `${current}\n\n${next}`
}

function relativeKnowledgeLink(fromPath: string, toPath: string): string {
  const fromParts = fromPath.split("/").slice(0, -1)
  const toParts = toPath.split("/")
  let i = 0
  while (
    i < fromParts.length &&
    i < toParts.length - 1 &&
    fromParts[i] === toParts[i]
  ) {
    i += 1
  }
  const up = fromParts.length - i
  const down = toParts.slice(i).join("/")
  if (up === 0) return down.startsWith(".") ? down : `./${down}`
  return `${"../".repeat(up)}${down}`
}

function pathIdentityOccupant(input: {
  preferred: string
  existingByPath: ReadonlyMap<string, ExistingKnowledgeFile>
  claimedUnkeyed: Set<string>
}): ExistingKnowledgeFile | null {
  const occupant = input.existingByPath.get(input.preferred)
  if (!occupant || input.claimedUnkeyed.has(input.preferred)) return null
  input.claimedUnkeyed.add(input.preferred)
  return occupant
}

function appendClaimSeeAlsoLinks(
  body: string,
  fromPath: string,
  claims: ReadonlyArray<{ to: string }>,
  titleByObjectId: ReadonlyMap<string, string>,
  pathByObjectId: ReadonlyMap<string, string>,
): string {
  const objectIdByPath = new Map<string, string>()
  for (const [objectId, path] of pathByObjectId) {
    objectIdByPath.set(path, objectId)
  }
  const additions: string[] = []
  for (const claim of claims) {
    if (!claim.to || body.includes(`](${claim.to})`)) continue
    const objectId = objectIdByPath.get(
      resolveKnowledgeHref(fromPath, claim.to),
    )
    const label =
      (objectId ? titleByObjectId.get(objectId) : null) ??
      linkLabelFromHref(claim.to)
    additions.push(`- [${label}](${claim.to})`)
  }
  if (additions.length === 0) return body.trim()
  if (/(^|\n)See also\n/i.test(body)) {
    return `${body.trim()}\n${additions.join("\n")}`
  }
  return `${body.trim()}\n\nSee also\n\n${additions.join("\n")}`
}

function resolveKnowledgeHref(fromPath: string, href: string): string {
  const dir = fromPath.split("/").slice(0, -1).join("/")
  const cleaned = (href.split("#")[0] ?? href).trim()
  const parts = `${dir ? `${dir}/` : ""}${cleaned}`.split("/")
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

function linkLabelFromHref(href: string): string {
  const base = href.split("/").pop()?.replace(/\.md$/i, "") ?? href
  return base
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function resolveImportedSource(input: {
  knowledgePath: string
  payload?: unknown
  objectDedupKey?: string | null
  evidenceKey?: string | null
  recordedSource?: string | null
  workspaceRepositoryUrl?: string | null
  repositoryGitUrlById: ReadonlyMap<string, string>
  existingPaths: ReadonlySet<string>
}): string | null {
  const recorded = canonicalRecordedSource(
    input.recordedSource,
    input.knowledgePath,
    input.existingPaths,
  )
  if (recorded) return recorded
  const repoPath =
    objectPathFromPayload(input.payload) ??
    pathFromLogicalSourceKey(input.evidenceKey) ??
    pathFromLogicalSourceKey(input.objectDedupKey)
  const repoId =
    repositoryIdFromDedup(input.objectDedupKey) ??
    repositoryIdFromDedup(input.evidenceKey)
  if (!repoId || !repoPath) return null
  const gitUrl = linkedRepositoryUrlSchema.safeParse(
    input.repositoryGitUrlById.get(repoId),
  )
  if (!gitUrl.success) return null
  const posix = repoPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
  if (!posix) return null
  const workspaceUrl = input.workspaceRepositoryUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceRepositoryUrl)
    : ""
  const repoUrl = normalizeWorkspaceRepositoryUrl(gitUrl.data)
  if (workspaceUrl && repoUrl && workspaceUrl === repoUrl) {
    if (!isWorkspaceTreePath(posix, input.existingPaths)) return null
    return relativeKnowledgeLink(input.knowledgePath, posix)
  }
  return `${checkoutableGitUrl(gitUrl.data)}#${posix}`
}

function canonicalRecordedSource(
  raw: string | null | undefined,
  knowledgePath: string,
  existingPaths: ReadonlySet<string>,
): string | null {
  const source = raw?.trim() ?? ""
  if (!source || isDatabaseSourceKey(source)) return null
  if (/^(?:https?|ssh|git):\/\//i.test(source) || source.startsWith("git@"))
    return linkedRepositoryUrlSchema.safeParse(source.split("#")[0]).success
      ? source
      : null
  if (source.startsWith(".")) return source
  if (isWorkspaceTreePath(source, existingPaths)) {
    return relativeKnowledgeLink(knowledgePath, source)
  }
  return null
}

function isDatabaseSourceKey(source: string): boolean {
  const trimmed = source.trim()
  if (/^(git|llm|manual|extract)$/i.test(trimmed)) return true
  if (/obj_/i.test(trimmed)) return true
  if (
    /^(evd|inu|svc|pat|lib|api|ops|skl|src):/i.test(trimmed) &&
    /repo_/i.test(trimmed)
  ) {
    return true
  }
  return false
}

function checkoutableGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\/+$/, "")
  if (trimmed.startsWith("git@")) return trimmed
  if (/\.git$/i.test(trimmed)) return trimmed
  if (/github\.com|gitlab\./i.test(trimmed)) return `${trimmed}.git`
  return trimmed
}

function pathFromLogicalSourceKey(
  key: string | null | undefined,
): string | null {
  const trimmed = key?.trim() ?? ""
  if (!trimmed) return null
  const match = trimmed.match(/^[^:]+:(repo_[^:]+):(.+)$/)
  const rest = match?.[2]?.trim() ?? ""
  if (!rest || rest === "./" || rest.startsWith("./:")) return null
  if (!rest.includes("/") && rest.includes(":")) return null
  return rest.replace(/^\.\//, "") || null
}

function isWorkspaceTreePath(
  path: string,
  existingPaths: ReadonlySet<string>,
): boolean {
  const posix = path.replace(/^\/+/, "").replace(/\\/g, "/")
  if (existingPaths.has(posix)) return true
  return (
    posix.startsWith("linear/") ||
    posix.startsWith("notion/") ||
    posix.startsWith("confluence/") ||
    posix.startsWith("slack/")
  )
}
