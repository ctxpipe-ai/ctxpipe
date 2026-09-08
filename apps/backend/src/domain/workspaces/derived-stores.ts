import type { HydrateUnit } from "./hydrate.js"

/** Embeddings are retryable. Failure must not roll back Postgres hydrate. */
export async function embedHydrateUnits(input: {
  units: readonly HydrateUnit[]
  embed: (texts: string[]) => Promise<number[][]>
}): Promise<Array<{ servingId: string; embedding: number[] }>> {
  const texts = input.units.map((unit) => unit.body.trim()).filter(Boolean)
  if (texts.length === 0) return []
  const vectors = await input.embed(texts)
  const out: Array<{ servingId: string; embedding: number[] }> = []
  let i = 0
  for (const unit of input.units) {
    if (!unit.body.trim()) continue
    const embedding = vectors[i]
    i += 1
    if (embedding) out.push({ servingId: unit.servingId, embedding })
  }
  return out
}

/** Omitted SHA denotes only the temporary legacy checkout. */
export function workspaceCheckoutKey(
  workspaceId: string,
  sha?: string,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId))
    throw new Error("Invalid workspace id")
  if (sha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Workspace checkout requires an immutable commit SHA")
  return sha ? `ws:${workspaceId}:${sha}` : `ws:${workspaceId}`
}
