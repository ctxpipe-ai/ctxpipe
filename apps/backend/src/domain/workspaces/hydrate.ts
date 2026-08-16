import { createHash } from "node:crypto"
import { base32nopad } from "@scure/base"
import {
  isConnectorMirrorPath,
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
    if (isConnectorMirrorPath(path)) continue
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
    })
  }

  return { units, skipped, linked }
}

export function hydrateIsNoop(
  previousSha: string | null,
  sha: string,
): boolean {
  return previousSha === sha
}

export function shouldReplaceKnowledgeProjection(input: {
  previousSha: string | null
  sha: string
}): boolean {
  return !hydrateIsNoop(input.previousSha, input.sha)
}

/** Copy root AGENTS.md front matter `name` onto the Workspace. Missing/malformed → null. */
export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
}): boolean {
  return input.hydrateStatus === "ready" && Boolean(input.activeProjectionSha)
}

export function hydrateUnitsToProjectionClaims(
  units: readonly HydrateUnit[],
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
  }> = []
  for (const unit of units) {
    const dir = unit.path.split("/").slice(0, -1).join("/")
    for (const [index, claim] of unit.claims.entries()) {
      if (!claim.predicate) continue
      const target = resolveHydrateLink(dir, claim.to)
      const object = byPath.get(target)
      if (!object) continue
      claims.push({
        id: `${unit.servingId}:${index}`,
        subjectId: unit.servingId,
        objectId: object.servingId,
        subjectKind: "KnowledgeUnit",
        objectKind: "KnowledgeUnit",
        predicate: claim.predicate,
        status: "active",
        aggregatedConfidence: claim.confidence ?? 0.5,
        sourceCount: 1,
        lastObservedAt: claim.validFrom ?? "1970-01-01T00:00:00.000Z",
        validFrom: claim.validFrom,
        validTo: claim.validTo,
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
      })
    }
  }
  return claims
}

function resolveHydrateLink(fromDir: string, href: string): string {
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
