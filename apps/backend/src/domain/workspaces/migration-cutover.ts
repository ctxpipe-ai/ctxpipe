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

/** Same fact → merge. Name collision only → a new filename. Fast model, tiny excerpts. */
const UNKEYED_COLLISION_TIMEOUT_MS = 8_000
const UNKEYED_COLLISION_EXCERPT_CHARS = 400

export function unkeyedCollisionExcerpt(text: string): string {
  return text.trim().slice(0, UNKEYED_COLLISION_EXCERPT_CHARS)
}

export function unkeyedCollisionPrompt(input: {
  existingPath: string
  incomingPath: string
  existingExcerpt: string
  incomingExcerpt: string
}): string {
  return [
    "Classify whether these two unkeyed knowledge files are the same fact or only a filename collision.",
    "Reply with merge or new_name only.",
    `Existing path: ${input.existingPath}`,
    `Incoming path: ${input.incomingPath}`,
    `Existing excerpt:\n${input.existingExcerpt}`,
    `Incoming excerpt:\n${input.incomingExcerpt}`,
  ].join("\n")
}

export function parseUnkeyedCollisionReply(
  raw: string,
): "merge" | "new_name" | "garbage" {
  const text = raw.trim().toLowerCase()
  if (text === "merge") return "merge"
  if (text === "new_name" || text === "new name") return "new_name"
  return "garbage"
}

async function invokeUnkeyedCollisionModel(prompt: string): Promise<string> {
  const { getModel } = await import("../../retrieval/services/modelProvider.js")
  const model = getModel("fast")
  const result = await model.invoke(prompt)
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String(part.text)
          : "",
      )
      .join("")
  }
  return String(content ?? "")
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function classifyUnkeyedKnowledgeCollision(input: {
  existingPath: string
  incomingPath: string
  existingExcerpt: string
  incomingExcerpt: string
  classify?: (prompt: string) => Promise<string>
  timeoutMs?: number
}): Promise<"merge" | "new_name"> {
  const classify = input.classify ?? invokeUnkeyedCollisionModel
  try {
    const raw = await withTimeout(
      classify(unkeyedCollisionPrompt(input)),
      input.timeoutMs ?? UNKEYED_COLLISION_TIMEOUT_MS,
    )
    return parseUnkeyedCollisionReply(raw) === "merge" ? "merge" : "new_name"
  } catch {
    return "new_name"
  }
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
