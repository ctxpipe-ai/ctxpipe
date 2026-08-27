import { createHash } from "node:crypto"
import {
  greenfieldKnowledgePath,
  knowledgeAreaFromObjectKind,
  parseSimpleFrontMatter,
} from "./layout.js"
import {
  assignImportedRepository,
  classifyUnkeyedKnowledgeCollision,
  mergeImportedClaims,
  nextKnowledgeUnitPath,
  shouldExportClaim,
  unkeyedCollisionExcerpt,
} from "./dest-workspace-first.js"
import { normalizeSlug, normalizeWorkspaceRepositoryUrl } from "./slug.js"

export const MIGRATION_EXPORT_KIND = "migration_export"

export function migrationExportFiles(input: {
  imported: ReadonlyArray<{ slug: string; body: string; area?: string }>
  takenPaths: Iterable<string>
  linkedUrls: Iterable<string>
}): Array<{ path: string; content: string }> {
  const taken = new Set(input.takenPaths)
  const files: Array<{ path: string; content: string }> = []
  for (const item of input.imported) {
    const path = nextKnowledgeUnitPath(item.area ?? "topics", item.slug, taken)
    taken.add(path)
    files.push({ path, content: item.body })
  }
  for (const url of input.linkedUrls) {
    const name = url
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
      .pop()
    if (!name) continue
    const path = `repositories/${name}.md`
    if (taken.has(path)) continue
    taken.add(path)
    files.push({
      path,
      content: `---\ngit: ${url}\n---\n`,
    })
  }
  return files
}

export function importKeyFromDedup(
  deduplicationKey: string | null,
): string | null {
  const key = deduplicationKey?.trim()
  return key ? key : null
}

export type ImportedMarkdownClaim = {
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
    generatedBy: input.generatedBy === undefined ? "ctxpipe" : input.generatedBy,
    source: input.source,
    claims: input.claims,
    body: `# ${input.title}\n\n${input.body.trim()}`,
  })
}

function rewriteImportedMarkdown(input: {
  importKey?: string | null
  kind?: string | null
  confidence?: number | null
  generatedBy?: string | null
  source?: string | null
  body: string
  claims: ReadonlyArray<ImportedMarkdownClaim>
}): string {
  return importedFrontMatter({
    importKey: input.importKey,
    kind: input.kind,
    confidence: input.confidence,
    generatedBy: input.generatedBy === undefined ? "ctxpipe" : input.generatedBy,
    source: input.source,
    claims: input.claims,
    body: input.body,
  })
}

function importedFrontMatter(input: {
  importKey?: string | null
  kind?: string | null
  confidence?: number | null
  generatedBy?: string | null
  source?: string | null
  body: string
  claims?: ReadonlyArray<ImportedMarkdownClaim>
}): string {
  const lines = ["---"]
  if (input.importKey) lines.push(`import_key: ${yamlScalar(input.importKey)}`)
  if (input.kind) lines.push(`kind: ${yamlScalar(input.kind)}`)
  if (input.confidence != null) {
    lines.push(`confidence: ${formatYamlNumber(input.confidence)}`)
  }
  if (input.generatedBy) {
    lines.push(`generated_by: ${yamlScalar(input.generatedBy)}`)
  }
  if (input.source) lines.push(`source: ${yamlScalar(input.source)}`)
  if (input.claims && input.claims.length > 0) {
    lines.push("claims:")
    for (const claim of input.claims) {
      lines.push(`  - to: ${yamlScalar(claim.to)}`)
      lines.push(`    predicate: ${yamlScalar(claim.predicate)}`)
      if (claim.confidence != null) {
        lines.push(`    confidence: ${formatYamlNumber(claim.confidence)}`)
      }
      if (claim.validFrom) {
        lines.push(`    valid_from: ${yamlScalar(claim.validFrom)}`)
      }
      if (claim.validTo) lines.push(`    valid_to: ${yamlScalar(claim.validTo)}`)
      if (claim.source) lines.push(`    source: ${yamlScalar(claim.source)}`)
    }
  }
  lines.push("---", "", input.body.trim(), "")
  return lines.join("\n")
}

function yamlScalar(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    /[\r\n]/.test(value) ||
    /^[#&*!|>'"%@`{}[\],]/.test(value) ||
    /: /.test(value) ||
    value.includes("#") ||
    /^https?:\/\//i.test(value) ||
    value.startsWith("git@")
  ) {
    return JSON.stringify(value)
  }
  return value
}

function formatYamlNumber(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const clamped = Math.min(1, Math.max(0, value))
  return String(Number(clamped.toFixed(6)))
}

export function noOpExportUsesResolvedTip(
  filesWouldChange: boolean,
  resolvedTip: string,
): { commit: false; exportSha: string } | { commit: true } {
  if (!filesWouldChange) return { commit: false, exportSha: resolvedTip }
  return { commit: true }
}

/** Cutover treats a recorded commit SHA as export completion, including no-ops. */
export function completedNoOpExportSha(
  noOp: { commit: false; exportSha: string } | { commit: true },
): string | null {
  if (noOp.commit) return null
  const sha = noOp.exportSha.trim()
  return sha.length > 0 ? sha : null
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

export function objectSummaryFromPayload(payload: unknown): string {
  return payloadString(payload, "summary")
}

export function objectConfidenceFromPayload(payload: unknown): number | null {
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

export function objectBodyFromPayload(
  payload: unknown,
  title?: string,
): string {
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

export async function planMigrationExport(input: {
  workspaceId: string
  firstWorkspaceId: string | null
  workspaceByRepositoryId: ReadonlyMap<string, string>
  objects: readonly ExportObjectRow[]
  claims: readonly ExportClaimRow[]
  existingKnowledge: readonly ExistingKnowledgeFile[]
  linkedUrls: Iterable<string>
  workspaceRepositoryUrl?: string | null
  repositoryGitUrlById?: ReadonlyMap<string, string>
  stampImportKey?: boolean
  classifyUnkeyed?: (prompt: string) => Promise<string>
}): Promise<{
  files: Array<{ path: string; content: string }>
  wouldChange: boolean
}> {
  const objectWorkspace = new Map<string, string>()
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

  const existingByImportKey = new Map<string, ExistingKnowledgeFile>()
  const existingByPath = new Map(
    input.existingKnowledge.map((file) => [file.path, file]),
  )
  const taken = new Set<string>()
  const claimedUnkeyed = new Set<string>()
  for (const file of input.existingKnowledge) {
    taken.add(file.path)
    const key = importKeyFromExisting(file.content)
    if (key && !existingByImportKey.has(key)) existingByImportKey.set(key, file)
  }

  const stampImportKey = input.stampImportKey !== false
  const existingPaths = new Set(input.existingKnowledge.map((file) => file.path))
  const sourceContext = {
    workspaceRepositoryUrl: input.workspaceRepositoryUrl ?? null,
    repositoryGitUrlById: input.repositoryGitUrlById ?? new Map(),
    existingPaths,
  }
  const pathByObjectId = new Map<string, string>()
  const titleByObjectId = new Map<string, string>()
  const bodyByObjectId = new Map<string, string>()
  const mergeFromByObjectId = new Map<string, ExistingKnowledgeFile>()
  const keyedRewriteByObjectId = new Set<string>()
  const claimsByObjectId = new Map<
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

  for (const object of assigned) {
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
            preferred,
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
    if (allocated.keyed) keyedRewriteByObjectId.add(object.id)
    if (occupant && !allocated.keyed) {
      const parsed = parseSimpleFrontMatter(occupant.content)
      const existingBody = parsed.malformed ? occupant.content : parsed.body
      bodyByObjectId.set(
        object.id,
        appendImportedBody(existingBody, importedBody),
      )
      claimsByObjectId.set(object.id, claimsFromExisting(occupant.content))
    } else if (occupant && allocated.keyed) {
      bodyByObjectId.set(object.id, importedBody)
      claimsByObjectId.set(object.id, claimsFromExisting(occupant.content))
    } else {
      bodyByObjectId.set(object.id, importedBody)
      claimsByObjectId.set(object.id, [])
    }
  }

  for (const claim of input.claims) {
    if (objectWorkspace.get(claim.subjectId) !== input.workspaceId) continue
    if (
      !shouldExportClaim({
        fromWorkspaceId: input.workspaceId,
        toWorkspaceId: objectWorkspace.get(claim.objectId) ?? null,
      })
    ) {
      continue
    }
    const fromPath = pathByObjectId.get(claim.subjectId)
    const toPath = pathByObjectId.get(claim.objectId)
    if (!fromPath || !toPath) continue
    const subject = assigned.find((object) => object.id === claim.subjectId)
    const current = claimsByObjectId.get(claim.subjectId) ?? []
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
    claimsByObjectId.set(
      claim.subjectId,
      mergeImportedClaims(current, [incoming]),
    )
  }

  const files: Array<{ path: string; content: string }> = []
  for (const object of assigned) {
    const path = pathByObjectId.get(object.id)
    if (!path) continue
    const importKey = stampImportKey
      ? importKeyForExportedObject(object)
      : null
    const title = titleByObjectId.get(object.id) ?? "Imported"
    const claims = (claimsByObjectId.get(object.id) ?? []).map((claim) => ({
      ...claim,
      confidence: claim.confidence ?? 0,
    }))
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
      content:
        occupant && !keyedRewriteByObjectId.has(object.id)
          ? rewriteImportedMarkdown({
              ...front,
              body,
            })
          : importedObjectMarkdown({
              ...front,
              title,
              body,
            }),
    })
  }
  files.push(
    ...migrationExportFiles({
      imported: [],
      takenPaths: taken,
      linkedUrls: input.linkedUrls,
    }),
  )

  const contentByPath = new Map(
    input.existingKnowledge.map((file) => [file.path, file.content]),
  )
  return {
    files,
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

export function resolveImportedSource(input: {
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
  const gitUrl = input.repositoryGitUrlById.get(repoId)
  if (!gitUrl) return null
  const posix = repoPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")
  if (!posix) return null
  const workspaceUrl = input.workspaceRepositoryUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceRepositoryUrl)
    : ""
  const repoUrl = normalizeWorkspaceRepositoryUrl(gitUrl)
  if (workspaceUrl && repoUrl && workspaceUrl === repoUrl) {
    if (!isWorkspaceTreePath(posix, input.existingPaths)) return null
    return relativeKnowledgeLink(input.knowledgePath, posix)
  }
  return `${checkoutableGitUrl(gitUrl)}#${posix}`
}

function canonicalRecordedSource(
  raw: string | null | undefined,
  knowledgePath: string,
  existingPaths: ReadonlySet<string>,
): string | null {
  const source = raw?.trim() ?? ""
  if (!source || isDatabaseSourceKey(source)) return null
  if (/^https?:\/\//i.test(source) || source.startsWith("git@")) return source
  if (source.startsWith(".")) return source
  if (isWorkspaceTreePath(source, existingPaths)) {
    return relativeKnowledgeLink(knowledgePath, source)
  }
  return null
}

export function isDatabaseSourceKey(source: string): boolean {
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

export function checkoutableGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\/+$/, "")
  if (trimmed.startsWith("git@")) return trimmed
  if (/\.git$/i.test(trimmed)) return trimmed
  if (/github\.com|gitlab\./i.test(trimmed)) return `${trimmed}.git`
  return trimmed
}

function pathFromLogicalSourceKey(key: string | null | undefined): string | null {
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
