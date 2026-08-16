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

/** Fail-closed: unkeyed same-path files get a new name. Fast LLM may merge later. */
export function classifyUnkeyedKnowledgeCollision(_input?: {
  existingBody?: string
  incomingBody?: string
}): "merge" | "new_name" {
  return "new_name"
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
  body?: string
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
  }
  return merged
}
