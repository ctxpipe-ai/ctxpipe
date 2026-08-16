import { bootstrapAgentsMarkdown, FOLDER_MAP_START } from "./bootstrap.js"
import type { HydrateClaim, HydrateUnit } from "./hydrate.js"
import { parseSimpleFrontMatter } from "./layout.js"
import { renameRewriteRemainder } from "./rename-rewrite.js"
import {
  shouldEnqueueAfterHydrate,
  shouldEnqueueWorkspaceWriteJob,
  type WorkspaceWriteJobKind,
} from "./write-jobs.js"

export function claimsUpgradeRemainder(units: readonly HydrateUnit[]): number {
  return units.filter((unit) =>
    unit.links.some((link) => !unit.claims.some((claim) => claim.to === link)),
  ).length
}

export function validFromPersistRemainder(
  units: readonly HydrateUnit[],
): number {
  return units.filter((unit) => unit.claims.some((claim) => !claim.validFrom))
    .length
}

export function opsFolderMapRemainder(agentsMd: string | null): number {
  if (!agentsMd?.trim()) return 1
  return agentsMd.includes(FOLDER_MAP_START) ? 0 : 1
}

export function hydrateWriteJobsToEnqueue(input: {
  units: readonly HydrateUnit[]
  agentsMd: string | null
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  previousPaths?: readonly string[]
  extractRemainder?: number
}): WorkspaceWriteJobKind[] {
  const gate = shouldEnqueueWorkspaceWriteJob(input)
  if (!gate.enqueue) return []
  const kinds: WorkspaceWriteJobKind[] = []
  if (claimsUpgradeRemainder(input.units) > 0) kinds.push("claims_upgrade")
  if (validFromPersistRemainder(input.units) > 0) {
    kinds.push("valid_from_persist")
  }
  if (opsFolderMapRemainder(input.agentsMd) > 0) kinds.push("ops_folder_map")
  if (
    renameRewriteRemainder({
      previousPaths: input.previousPaths ?? [],
      currentPaths: input.units.map((unit) => unit.path),
      units: input.units,
    }) > 0
  ) {
    kinds.push("rename_rewrite")
  }
  if ((input.extractRemainder ?? 0) > 0) kinds.push("extract_ingest")
  return kinds
}

export function hydrateWriteJobRemainders(input: {
  units: readonly HydrateUnit[]
  agentsMd: string | null
  previousPaths?: readonly string[]
  extractRemainder?: number
}): Partial<Record<WorkspaceWriteJobKind, number>> {
  return {
    claims_upgrade: claimsUpgradeRemainder(input.units),
    valid_from_persist: validFromPersistRemainder(input.units),
    ops_folder_map: opsFolderMapRemainder(input.agentsMd),
    rename_rewrite: renameRewriteRemainder({
      previousPaths: input.previousPaths ?? [],
      currentPaths: input.units.map((unit) => unit.path),
      units: input.units,
    }),
    extract_ingest: input.extractRemainder ?? 0,
  }
}

export function kindsToRetryAfterHydrate(input: {
  remaining: readonly WorkspaceWriteJobKind[]
  remainderBefore: Partial<Record<string, number>>
  remainderAfter: Partial<Record<string, number>>
  attemptsForSha: Readonly<Record<string, number>>
}): WorkspaceWriteJobKind[] {
  return input.remaining.filter((kind) =>
    shouldEnqueueAfterHydrate({
      attemptsForSha: input.attemptsForSha[kind] ?? 0,
      remainderBefore: input.remainderBefore[kind] ?? 0,
      remainderAfter: input.remainderAfter[kind] ?? 0,
    }),
  )
}

function serializeKnowledgeFile(input: {
  attributes: Record<string, unknown>
  body: string
}): string {
  const lines = ["---"]
  for (const [key, value] of Object.entries(input.attributes)) {
    if (key === "claims" && Array.isArray(value)) {
      lines.push("claims:")
      for (const item of value) {
        if (!item || typeof item !== "object") continue
        const row = item as Record<string, unknown>
        const entries = Object.entries(row).filter(([, field]) => field != null)
        const first = entries[0]
        if (!first) continue
        lines.push(`  - ${first[0]}: ${String(first[1])}`)
        for (const [field, fieldValue] of entries.slice(1)) {
          lines.push(`    ${field}: ${String(fieldValue)}`)
        }
      }
      continue
    }
    if (value == null) continue
    lines.push(`${key}: ${String(value)}`)
  }
  lines.push("---")
  return `${lines.join("\n")}\n\n${input.body.trim()}\n`
}

function claimRecord(claim: HydrateClaim): Record<string, unknown> {
  return {
    to: claim.to,
    ...(claim.predicate ? { predicate: claim.predicate } : {}),
    ...(claim.confidence != null ? { confidence: claim.confidence } : {}),
    ...(claim.validFrom ? { valid_from: claim.validFrom } : {}),
    ...(claim.validTo ? { valid_to: claim.validTo } : {}),
    ...(claim.source ? { source: claim.source } : {}),
  }
}

export function claimsUpgradeFiles(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  units: readonly HydrateUnit[]
}): Array<{ path: string; content: string }> {
  const byPath = new Map(input.units.map((unit) => [unit.path, unit]))
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    const unit = byPath.get(file.path)
    if (!unit) continue
    const missing = unit.links.filter(
      (link) => !unit.claims.some((claim) => claim.to === link),
    )
    if (missing.length === 0) continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    const claims = [
      ...unit.claims.map(claimRecord),
      ...missing.map((to) => ({ to })),
    ]
    out.push({
      path: file.path,
      content: serializeKnowledgeFile({
        attributes: { ...parsed.attributes, claims },
        body: parsed.body,
      }),
    })
  }
  return out
}

export function validFromPersistFiles(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  units: readonly HydrateUnit[]
  introducingSha: string
}): Array<{ path: string; content: string }> {
  const byPath = new Map(input.units.map((unit) => [unit.path, unit]))
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    const unit = byPath.get(file.path)
    if (!unit || !unit.claims.some((claim) => !claim.validFrom)) continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    const claims = unit.claims.map((claim) =>
      claimRecord({
        ...claim,
        validFrom: claim.validFrom ?? input.introducingSha,
      }),
    )
    out.push({
      path: file.path,
      content: serializeKnowledgeFile({
        attributes: { ...parsed.attributes, claims },
        body: parsed.body,
      }),
    })
  }
  return out
}

export function extractIngestFiles(input: {
  proposed: ReadonlyArray<{ path: string; content: string }>
  existing: ReadonlyMap<string, string>
}): Array<{ path: string; content: string }> {
  return input.proposed.filter(
    (file) =>
      file.path.startsWith("knowledge/") &&
      input.existing.get(file.path) !== file.content,
  )
}

export function extractIngestRemainder(input: {
  proposed: ReadonlyArray<{ path: string; content: string }>
  existing: ReadonlyMap<string, string>
}): number {
  return extractIngestFiles(input).length
}

export function opsFolderMapFiles(input: {
  displayName: string
  existingAgentsMd: string | null
}): Array<{ path: string; content: string }> {
  const content = bootstrapAgentsMarkdown({
    displayName: input.displayName,
    existing: input.existingAgentsMd,
  })
  if (input.existingAgentsMd === content) return []
  return [{ path: "AGENTS.md", content }]
}
