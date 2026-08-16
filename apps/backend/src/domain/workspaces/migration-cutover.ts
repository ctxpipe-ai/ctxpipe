/** Distinct connector-target rows: created_at, then id. */
export function firstConnectorTarget<T extends { createdAt: Date; id: string }>(
  targets: readonly T[],
): T | null {
  if (targets.length === 0) return null
  return (
    [...targets].sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime()
      if (byTime !== 0) return byTime
      if (a.id < b.id) return -1
      if (a.id > b.id) return 1
      return 0
    })[0] ?? null
  )
}

export function assignImportedRepository(input: {
  repositoryId: string | null
  workspaceByRepositoryId: ReadonlyMap<string, string>
  firstWorkspaceId: string | null
}): { workspaceId: string } | { skip: "no_workspace" } {
  if (input.repositoryId) {
    const workspaceId = input.workspaceByRepositoryId.get(input.repositoryId)
    if (workspaceId) return { workspaceId }
  }
  if (input.firstWorkspaceId) return { workspaceId: input.firstWorkspaceId }
  return { skip: "no_workspace" }
}

export function shouldExportClaim(input: {
  fromWorkspaceId: string
  toWorkspaceId: string | null
}): boolean {
  return input.toWorkspaceId === input.fromWorkspaceId
}

/** Distinct connector-target git URLs that still need a Workspace. */
export function workspacesToCreateForConnectorTargets(input: {
  repositories: ReadonlyArray<{ gitUrl: string }>
  existingWorkspaceUrls: Iterable<string>
  normalizeUrl: (url: string) => string
}): string[] {
  const existing = new Set(
    [...input.existingWorkspaceUrls].map((url) => input.normalizeUrl(url)),
  )
  const created: string[] = []
  for (const repo of input.repositories) {
    const url = input.normalizeUrl(repo.gitUrl)
    if (!url || existing.has(url)) continue
    existing.add(url)
    created.push(url)
  }
  return created
}

export function planVersionStartCutover(input: {
  connectorTargets: ReadonlyArray<{ gitUrl: string }>
  existingWorkspaceUrls: Iterable<string>
  persistedFirstWorkspaceId: string | null
  normalizeUrl: (url: string) => string
}): {
  urlsToCreate: string[]
  persistFirst: boolean
  enqueueExports: boolean
} {
  const urlsToCreate = workspacesToCreateForConnectorTargets({
    repositories: input.connectorTargets,
    existingWorkspaceUrls: input.existingWorkspaceUrls,
    normalizeUrl: input.normalizeUrl,
  })
  const hasTargets = input.connectorTargets.some(
    (row) => input.normalizeUrl(row.gitUrl).length > 0,
  )
  return {
    urlsToCreate,
    persistFirst: hasTargets && !input.persistedFirstWorkspaceId,
    enqueueExports: hasTargets,
  }
}

export function workspacesNeedingMigrationExport(input: {
  workspaces: ReadonlyArray<{ id: string }>
  completedExportWorkspaceIds: Iterable<string>
}): string[] {
  const done = new Set(input.completedExportWorkspaceIds)
  return input.workspaces
    .filter((workspace) => !done.has(workspace.id))
    .map((workspace) => workspace.id)
}

export function firstWorkspaceIdForCutover(input: {
  persistedFirstWorkspaceId: string | null
  currentWorkspaceIds: readonly string[]
  computedFirstWorkspaceId?: string | null
}): string | null {
  void input.computedFirstWorkspaceId
  if (
    input.persistedFirstWorkspaceId &&
    input.currentWorkspaceIds.includes(input.persistedFirstWorkspaceId)
  ) {
    return input.persistedFirstWorkspaceId
  }
  return null
}

/** Same fact → merge. Name collision only → a new filename. */
export function classifyUnkeyedKnowledgeCollision(input?: {
  existingBody?: string
  incomingBody?: string
}): "merge" | "new_name" {
  const existing = (input?.existingBody ?? "").trim()
  const incoming = (input?.incomingBody ?? "").trim()
  if (!existing || !incoming) return "merge"
  if (existing === incoming) return "merge"
  if (existing.includes(incoming) || incoming.includes(existing)) return "merge"
  const existingHeading = markdownHeading(existing)
  const incomingHeading = markdownHeading(incoming)
  if (existingHeading && existingHeading === incomingHeading) return "merge"
  return "new_name"
}

function markdownHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim().toLowerCase() ?? null
}

export function nextImportedKnowledgePath(
  slug: string,
  takenPaths: Iterable<string>,
): string {
  const taken = new Set(takenPaths)
  const base = `knowledge/imported/${slug}.md`
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const path = `knowledge/imported/${slug}-${n}.md`
    if (!taken.has(path)) return path
  }
  throw new Error("Unable to allocate imported knowledge path")
}

type ImportedClaim = {
  to: string
  predicate: string
  confidence?: number
  validFrom?: string | null
  validTo?: string | null
  source?: string | null
  body?: string
}

function keepExistingUnlessIncoming<T>(
  existing: T | null | undefined,
  incoming: T | null | undefined,
): T | null | undefined {
  if (incoming == null || incoming === "") return existing
  return incoming
}

/** Union claims on (to, predicate); keep higher confidence; append a new body. */
export function mergeImportedClaims(
  existing: readonly ImportedClaim[],
  incoming: readonly ImportedClaim[],
): ImportedClaim[] {
  const merged = existing.map((claim) => ({ ...claim }))
  for (const next of incoming) {
    const index = merged.findIndex(
      (claim) => claim.to === next.to && claim.predicate === next.predicate,
    )
    if (index < 0) {
      merged.push({ ...next })
      continue
    }
    const current = merged[index]
    if (!current) continue
    const currentConfidence = current.confidence ?? 0
    const nextConfidence = next.confidence ?? 0
    if (nextConfidence > currentConfidence) current.confidence = next.confidence
    if (next.body && current.body !== next.body) {
      if (!current.body) current.body = next.body
      else if (!current.body.includes(next.body)) {
        current.body = `${current.body}\n\n${next.body}`
      }
    }
    current.validFrom = keepExistingUnlessIncoming(
      current.validFrom,
      next.validFrom,
    )
    current.validTo = keepExistingUnlessIncoming(current.validTo, next.validTo)
    current.source = keepExistingUnlessIncoming(current.source, next.source)
  }
  return merged
}
