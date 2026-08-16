import type { HydrateUnit } from "./hydrate.js"
import { hydrateUnitsToProjectionClaims } from "./hydrate.js"

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

export function graphClaimsFromHydratedUnits(units: readonly HydrateUnit[]) {
  return hydrateUnitsToProjectionClaims(units)
}

export function workspaceGraphProjectionScope(input: {
  workspaceId: string
  projectionSha: string
}): { workspaceId: string; projectionSha: string } | null {
  const workspaceId = input.workspaceId.trim()
  const projectionSha = input.projectionSha.trim()
  if (!workspaceId || !projectionSha) return null
  return { workspaceId, projectionSha }
}

export function staleWorkspaceGraphDeleteCypher(): string {
  return `MATCH (n { orgId: $orgId, workspaceId: $workspaceId })
WHERE n.projectionSha <> $projectionSha
DETACH DELETE n`
}

export function workspaceCheckoutKey(workspaceId: string): string {
  return `ws:${workspaceId}`
}

export function codesearchSelectsWorkspaceCheckout(input: {
  checkoutKey: string
  workspaceId: string
}): boolean {
  return input.checkoutKey === workspaceCheckoutKey(input.workspaceId)
}

/** Search the active projection’s workspace remote plus that SHA’s linked set. Relinked B stays out until activate. */
export function codesearchMembershipGitUrls(input: {
  activeProjectionUrl: string | null
  linked: ReadonlyArray<{ gitUrl: string }>
  normalizeUrl: (url: string) => string
}): string[] {
  const active = input.activeProjectionUrl
    ? input.normalizeUrl(input.activeProjectionUrl)
    : ""
  if (!active) return []
  const urls = [active]
  const seen = new Set([active])
  for (const row of input.linked) {
    const url = input.normalizeUrl(row.gitUrl)
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}
