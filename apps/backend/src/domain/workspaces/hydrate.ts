import { createHash } from "node:crypto"
import { base32nopad } from "@scure/base"
import { effectiveValidFrom } from "./hydrate-phases.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
  parseSimpleFrontMatter,
} from "./layout.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export function servingIdForKnowledgePath(
  workspaceId: string,
  path: string,
): string {
  const normalised = path.replace(/^\/+/, "").replaceAll("\\", "/")
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${normalised}`)
    .digest()
    .subarray(0, 16)
  return `kn_${base32nopad.encode(digest).toLowerCase()}`
}

export type HydrateClaim = {
  to: string
  predicate: string | null
  confidence: number | null
  validFrom: string | null
  validTo: string | null
  source: string | null
}

export type HydrateUnit = {
  path: string
  servingId: string
  body: string
  links: string[]
  claims: HydrateClaim[]
  confidence?: number | null
}

export type HydrateSkip = {
  path: string
  reason: "malformed" | "not_knowledge"
}

const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g

export function hydrateKnowledgeTree(input: {
  workspaceId: string
  files: ReadonlyArray<{ path: string; content: string }>
}): {
  units: HydrateUnit[]
  skipped: HydrateSkip[]
  linked: Array<{ path: string; git: string; branch: string | null }>
} {
  const units: HydrateUnit[] = []
  const skipped: HydrateSkip[] = []
  const linked: Array<{ path: string; git: string; branch: string | null }> = []
  const seenLinked = new Set<string>()

  for (const file of input.files) {
    const path = file.path.replace(/^\/+/, "")
    if (isLinkedRepositoryDeclaration(path)) {
      const parsed = parseLinkedRepositoryMarkdown(file.content)
      if (parsed.malformed) {
        skipped.push({ path, reason: "malformed" })
        continue
      }
      const git = normalizeWorkspaceRepositoryUrl(parsed.git)
      if (!git || seenLinked.has(git)) {
        skipped.push({ path, reason: "malformed" })
        continue
      }
      seenLinked.add(git)
      linked.push({ path, git, branch: parsed.branch })
      continue
    }
    if (!path.endsWith(".md")) continue
    if (path === "AGENTS.md" || path.startsWith(".agents/")) continue

    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) {
      skipped.push({ path, reason: "malformed" })
      continue
    }

    units.push({
      path,
      servingId: servingIdForKnowledgePath(input.workspaceId, path),
      body: parsed.body,
      links: markdownLinks(parsed.body),
      claims: parseClaims(parsed.attributes.claims),
      confidence: parseOptionalNumber(parsed.attributes.confidence),
    })
  }

  return { units, skipped, linked }
}

export function shouldHydrateBeforeMigrationExport(
  migrationExportSha: string | null | undefined,
): boolean {
  return !migrationExportSha
}

export function applyEffectiveValidFromToUnits(
  units: readonly HydrateUnit[],
  introducingCommits: ReadonlyMap<string, string>,
): HydrateUnit[] {
  return units.map((unit) => ({
    ...unit,
    claims: unit.claims.map((claim) => ({
      ...claim,
      validFrom: effectiveValidFrom({
        recorded: claim.validFrom,
        introducingCommitTimestamp: introducingCommits.get(unit.path) ?? null,
      }),
    })),
  }))
}

export function hydrateUnitsToProjectionClaims(
  units: readonly HydrateUnit[],
  introducingCommitTimestamp?: string | null,
): Array<{
  id: string
  subjectId: string
  objectId: string
  subjectKind: string
  objectKind: string
  predicate: string
  status: string
  aggregatedConfidence: number
  sourceCount: number
  lastObservedAt: string
  validFrom: string | null
  validTo: string | null
  source: string | null
}> {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const claims: Array<{
    id: string
    subjectId: string
    objectId: string
    subjectKind: string
    objectKind: string
    predicate: string
    status: string
    aggregatedConfidence: number
    sourceCount: number
    lastObservedAt: string
    validFrom: string | null
    validTo: string | null
    source: string | null
  }> = []
  for (const unit of units) {
    const dir = unit.path.split("/").slice(0, -1).join("/")
    for (const [index, claim] of unit.claims.entries()) {
      const target = resolveHydrateLink(dir, claim.to)
      const object = byPath.get(target)
      if (!object) continue
      const validFrom = effectiveValidFrom({
        recorded: claim.validFrom,
        introducingCommitTimestamp: introducingCommitTimestamp ?? null,
      })
      claims.push({
        id: `${unit.servingId}:${index}`,
        subjectId: unit.servingId,
        objectId: object.servingId,
        subjectKind: "KnowledgeUnit",
        objectKind: "KnowledgeUnit",
        predicate: claim.predicate || "LINKS_TO",
        status: "active",
        aggregatedConfidence: claim.confidence ?? unit.confidence ?? 0.5,
        sourceCount: 1,
        lastObservedAt: validFrom ?? "1970-01-01T00:00:00.000Z",
        validFrom,
        validTo: claim.validTo,
        source: claim.source,
      })
    }
    for (const [index, href] of unit.links.entries()) {
      const target = resolveHydrateLink(dir, href)
      const object = byPath.get(target)
      if (!object) continue
      if (
        unit.claims.some(
          (claim) => resolveHydrateLink(dir, claim.to) === target,
        )
      ) {
        continue
      }
      claims.push({
        id: `${unit.servingId}:link:${index}`,
        subjectId: unit.servingId,
        objectId: object.servingId,
        subjectKind: "KnowledgeUnit",
        objectKind: "KnowledgeUnit",
        predicate: "LINKS_TO",
        status: "active",
        aggregatedConfidence: 1,
        sourceCount: 1,
        lastObservedAt: "1970-01-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
        source: "git",
      })
    }
  }
  return claims
}

export function resolveHydrateLink(fromDir: string, href: string): string {
  const cleaned = href.split("#")[0] ?? href
  if (!cleaned || cleaned.startsWith("http:") || cleaned.startsWith("https:")) {
    return ""
  }
  const parts = (fromDir ? `${fromDir}/${cleaned}` : cleaned).split("/")
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

export function displayNameFromAgentsMarkdown(raw: string): string | null {
  const parsed = parseSimpleFrontMatter(raw)
  if (parsed.malformed) return null
  const name =
    typeof parsed.attributes.name === "string"
      ? parsed.attributes.name.trim()
      : ""
  return name || null
}

function parseOptionalNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function parseClaims(raw: unknown): HydrateClaim[] {
  if (!Array.isArray(raw)) return []
  const claims: HydrateClaim[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const to = typeof row.to === "string" ? row.to.trim() : ""
    if (!to) continue
    claims.push({
      to,
      predicate: typeof row.predicate === "string" ? row.predicate : null,
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      validFrom: typeof row.valid_from === "string" ? row.valid_from : null,
      validTo: typeof row.valid_to === "string" ? row.valid_to : null,
      source: typeof row.source === "string" ? row.source : null,
    })
  }
  return claims
}

function markdownLinks(body: string): string[] {
  const links: string[] = []
  for (const match of body.matchAll(MD_LINK)) {
    const href = match[2]?.trim()
    if (!href || href.startsWith("http:") || href.startsWith("https:")) continue
    if (href.startsWith("#")) continue
    links.push(href.split("#")[0] ?? href)
  }
  return links
}
