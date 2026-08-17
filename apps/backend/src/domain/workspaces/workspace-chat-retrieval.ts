export type WorkspaceChatUnit = {
  servingId: string
  path: string
  body: string
  projectionSha?: string
  embedding?: number[] | null
  claims?: ReadonlyArray<{ to: string; predicate: string | null }>
}

const RRF_K = 60

export function workspaceChatRetrievalSnippets(input: {
  query: string
  units: ReadonlyArray<{ path: string; body: string }>
  limit?: number
}): string {
  return formatWorkspaceChatHits({
    activeProjectionSha: "active",
    hits: workspaceChatHybridHits({
      query: input.query,
      activeProjectionSha: "active",
      units: input.units.map((unit, index) => ({
        servingId: `tmp_${index}`,
        path: unit.path,
        body: unit.body,
      })),
      limit: input.limit ?? 6,
    }),
  }).replace(" (active)", "")
}

export function workspaceChatHybridHits(input: {
  query: string
  activeProjectionSha: string | null
  units: ReadonlyArray<WorkspaceChatUnit>
  embedding?: number[] | null
  objectHits?: ReadonlyArray<{ objectId: string }>
  limit?: number
}): Array<{
  path: string
  body: string
  servingId: string
  claims: ReadonlyArray<{ to: string; predicate: string | null }>
}> {
  const sha = input.activeProjectionSha?.trim() ?? ""
  if (!sha) return []
  const units = input.units.filter(
    (unit) => !unit.projectionSha || unit.projectionSha === sha,
  )
  const allowed = new Set(units.map((unit) => unit.servingId))
  const lexical = rankLexical(input.query, units)
  const vector = rankVector(input.embedding ?? null, units)
  const fused = rrfMerge([
    lexical,
    vector,
    (input.objectHits ?? [])
      .map((hit) => hit.objectId)
      .filter((id) => allowed.has(id)),
  ])
  const byId = new Map(units.map((unit) => [unit.servingId, unit]))
  const hits: Array<{
    path: string
    body: string
    servingId: string
    claims: ReadonlyArray<{ to: string; predicate: string | null }>
  }> = []
  for (const id of fused) {
    const unit = byId.get(id)
    if (!unit) continue
    hits.push({
      servingId: unit.servingId,
      path: unit.path,
      body: unit.body,
      claims: unit.claims ?? [],
    })
    if (hits.length >= (input.limit ?? 8)) break
  }
  return hits
}

export function formatWorkspaceChatHits(input: {
  activeProjectionSha: string
  hits: ReadonlyArray<{
    path: string
    body: string
    claims?: ReadonlyArray<{ to: string; predicate: string | null }>
  }>
}): string {
  if (input.hits.length === 0) return ""
  return [
    `Workspace projection context (${input.activeProjectionSha}):`,
    ...input.hits.map((hit) => {
      const claims = (hit.claims ?? [])
        .map((claim) => `- ${claim.predicate ?? "related"} ${claim.to}`)
        .join("\n")
      return claims
        ? `## ${hit.path}\n${hit.body.trim().slice(0, 1200)}\nClaims:\n${claims}`
        : `## ${hit.path}\n${hit.body.trim().slice(0, 1200)}`
    }),
  ].join("\n\n")
}

function rankLexical(
  query: string,
  units: ReadonlyArray<WorkspaceChatUnit>,
): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2)
  return units
    .map((unit) => {
      const haystack =
        `${unit.path}\n${unit.body}\n${(unit.claims ?? []).map((claim) => `${claim.predicate ?? ""} ${claim.to}`).join("\n")}`.toLowerCase()
      const score = terms.reduce(
        (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
        0,
      )
      return { id: unit.servingId, score }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.id)
}

function rankVector(
  embedding: number[] | null,
  units: ReadonlyArray<WorkspaceChatUnit>,
): string[] {
  if (!embedding || embedding.length === 0) return []
  return units
    .map((unit) => ({
      id: unit.servingId,
      score: cosine(embedding, unit.embedding ?? []),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.id)
}

function rrfMerge(rankings: ReadonlyArray<readonly string[]>): string[] {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}
