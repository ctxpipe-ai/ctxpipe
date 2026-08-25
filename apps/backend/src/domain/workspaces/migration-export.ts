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
import { normalizeSlug } from "./slug.js"

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

export function importedObjectMarkdown(input: {
  title: string
  body: string
  importKey: string
  claims?: ReadonlyArray<{
    to: string
    predicate: string
    confidence?: number
    validFrom?: string | null
    validTo?: string | null
    source?: string | null
  }>
}): string {
  return importedFrontMatter({
    importKey: input.importKey,
    claims: input.claims,
    body: `# ${input.title}\n\n${input.body.trim()}`,
  })
}

function rewriteImportedMarkdown(input: {
  importKey: string
  body: string
  claims: ReadonlyArray<{
    to: string
    predicate: string
    confidence?: number
    validFrom?: string | null
    validTo?: string | null
    source?: string | null
  }>
}): string {
  return importedFrontMatter({
    importKey: input.importKey,
    claims: input.claims,
    body: input.body,
  })
}

function importedFrontMatter(input: {
  importKey: string
  body: string
  claims?: ReadonlyArray<{
    to: string
    predicate: string
    confidence?: number
    validFrom?: string | null
    validTo?: string | null
    source?: string | null
  }>
}): string {
  const lines = [`---`, `import_key: ${input.importKey}`]
  if (input.claims && input.claims.length > 0) {
    lines.push("claims:")
    for (const claim of input.claims) {
      lines.push(`  - to: ${claim.to}`)
      lines.push(`    predicate: ${claim.predicate}`)
      if (claim.confidence != null)
        lines.push(`    confidence: ${claim.confidence}`)
      if (claim.validFrom) lines.push(`    valid_from: ${claim.validFrom}`)
      if (claim.validTo) lines.push(`    valid_to: ${claim.validTo}`)
      if (claim.source) lines.push(`    source: ${claim.source}`)
    }
  }
  lines.push("---", "", input.body.trim(), "")
  return lines.join("\n")
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
  const body = objectBodyFromPayload(object.payload)
  const digest = createHash("sha256")
    .update(`${title}\0${body}`)
    .digest("hex")
    .slice(0, 16)
  return `src:${digest}`
}

export function objectTitleFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Imported"
  const record = payload as Record<string, unknown>
  for (const key of ["title", "name"] as const) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return "Imported"
}

export function objectBodyFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const record = payload as Record<string, unknown>
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : ""
  return summary
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

  const pathByObjectId = new Map<string, string>()
  const titleByObjectId = new Map<string, string>()
  const bodyByObjectId = new Map<string, string>()
  const mergeFromByObjectId = new Map<string, ExistingKnowledgeFile>()
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
    const existing = existingByImportKey.get(importKey)
    const allocated = existing
      ? { path: existing.path, mergeFrom: existing }
      : await allocateUnkeyedKnowledgePath({
          area: knowledgeAreaFromObjectKind(object.kind),
          slug: normalizeSlug(objectTitleFromPayload(object.payload)),
          incomingBody: objectBodyFromPayload(object.payload),
          taken,
          existingByPath,
          claimedUnkeyed,
          classifyUnkeyed: input.classifyUnkeyed,
        })
    const path = allocated.path
    taken.add(path)
    pathByObjectId.set(object.id, path)
    titleByObjectId.set(object.id, objectTitleFromPayload(object.payload))
    const importedBody = objectBodyFromPayload(object.payload)
    const occupant = allocated.mergeFrom
    if (occupant) mergeFromByObjectId.set(object.id, occupant)
    if (occupant) {
      const parsed = parseSimpleFrontMatter(occupant.content)
      const existingBody = parsed.malformed ? occupant.content : parsed.body
      bodyByObjectId.set(
        object.id,
        appendImportedBody(existingBody, importedBody),
      )
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
    const current = claimsByObjectId.get(claim.subjectId) ?? []
    const incoming = {
      to: relativeKnowledgeLink(fromPath, toPath),
      predicate: claim.predicate,
      confidence: claim.aggregatedConfidence,
      validFrom: isoDate(claim.validFrom),
      validTo: isoDate(claim.validTo),
      source: claim.source ?? null,
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
    const importKey = importKeyForExportedObject(object)
    const existing =
      existingByImportKey.get(importKey) ?? mergeFromByObjectId.get(object.id)
    files.push({
      path,
      content: existing
        ? rewriteImportedMarkdown({
            importKey,
            body: bodyByObjectId.get(object.id) ?? "",
            claims: claimsByObjectId.get(object.id) ?? [],
          })
        : importedObjectMarkdown({
            title: titleByObjectId.get(object.id) ?? "Imported",
            body: bodyByObjectId.get(object.id) ?? "",
            importKey,
            claims: claimsByObjectId.get(object.id),
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
