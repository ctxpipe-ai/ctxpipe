import { isAlias, isMap, isSeq } from "yaml"

import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { GENERATED_BY as INGESTION_V2_GENERATED_BY } from "../ingestion/patch-validator.js"
import { FROM_SOURCE_PREDICATE } from "./graph-relevance.js"
import { looksLikeGitSha } from "./hydrate-phases.js"
import {
  claimHasEvidence,
  type HydrateUnit,
  resolveHydrateLink,
} from "./hydrate.js"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  removeMetadataKey,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import { parseSimpleFrontMatter } from "./layout.js"
import { WORKSPACE_LINK_SCHEME } from "./mirror-units.js"
import { renameRewriteRemainder } from "./rename-rewrite.js"
import {
  shouldEnqueueAfterHydrate,
  shouldEnqueueWorkspaceWriteJob,
  type WorkspaceWriteJobKind,
} from "./write-jobs.js"

/**
 * True for a file that ingestion v2 owns. Its steps write its claims. Its
 * patch validator refuses a claim with no predicate or no evidence. So no
 * host job adds a claim to it (CTX-1100). A body link still makes its
 * `LINKS_TO` edge in hydrate.
 */
function ownedByIngestion(unit: HydrateUnit): boolean {
  return unit.generatedBy === INGESTION_V2_GENERATED_BY
}

/** True when a file that ingestion v2 owns has a claim with no evidence. */
function needsClaimRepair(unit: HydrateUnit): boolean {
  return ownedByIngestion(unit) && unit.hasClaimWithoutEvidence === true
}

function missingClaimLinks(unit: HydrateUnit): string[] {
  // The connector sync owns a mirror file, so no claims are written into it.
  if (isConnectorMirrorPath(unit.path) || ownedByIngestion(unit)) return []
  const directory = unit.path.split("/").slice(0, -1).join("/")
  const targets = new Set(
    unit.claims.map((claim) => resolveHydrateLink(directory, claim.to)),
  )
  return unit.links.filter((link) => {
    // A resolved reference makes its own edge, so it needs no claim.
    if (link.startsWith(WORKSPACE_LINK_SCHEME)) return false
    const target = resolveHydrateLink(directory, link)
    if (!target || targets.has(target)) return false
    targets.add(target)
    return true
  })
}

export function claimsUpgradeRemainder(units: readonly HydrateUnit[]): number {
  return units.filter(
    (unit) => missingClaimLinks(unit).length > 0 || needsClaimRepair(unit),
  ).length
}

/**
 * True when hydrate must write a `valid_from` for a claim of the `claims`
 * front matter. A `FROM_SOURCE` claim comes from the `sources` front matter,
 * which has no `valid_from`, so no write can give it one.
 */
function claimNeedsValidFrom(claim: HydrateUnit["claims"][number]): boolean {
  if (claim.predicate === FROM_SOURCE_PREDICATE) return false
  return !claim.validFrom || looksLikeGitSha(claim.validFrom)
}

export function validFromPersistRemainder(
  units: readonly HydrateUnit[],
): number {
  return units.filter((unit) => unit.claims.some(claimNeedsValidFrom)).length
}

export function hydrateWriteJobsToEnqueue(input: {
  units: readonly HydrateUnit[]
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  previousPaths?: readonly string[]
  extractRemainder?: number
}): WorkspaceWriteJobKind[] {
  const gate = shouldEnqueueWorkspaceWriteJob(input)
  if (!gate.enqueue && gate.reason === "stale_generation") return []
  const kinds: WorkspaceWriteJobKind[] = []
  if (claimsUpgradeRemainder(input.units) > 0) kinds.push("claims_upgrade")
  if (validFromPersistRemainder(input.units) > 0) {
    kinds.push("valid_from_persist")
  }
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
  previousPaths?: readonly string[]
  extractRemainder?: number
}): Partial<Record<WorkspaceWriteJobKind, number>> {
  return {
    claims_upgrade: claimsUpgradeRemainder(input.units),
    valid_from_persist: validFromPersistRemainder(input.units),
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

export function claimsUpgradeFiles(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  units: readonly HydrateUnit[]
}): Array<{ path: string; content: string }> {
  const byPath = new Map(input.units.map((unit) => [unit.path, unit]))
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    const unit = byPath.get(file.path)
    if (!unit) continue
    const missing = missingClaimLinks(unit)
    const repair = needsClaimRepair(unit)
    if (missing.length === 0 && !repair) continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    const content = repair
      ? withoutClaimsLackingEvidence(file.content, parsed.attributes.claims)
      : withLinkClaims(file.content, missing)
    // A file that the job does not change gets no commit.
    if (content !== file.content) out.push({ path: file.path, content })
  }
  return out
}

/** The file with a claim `{ to }` for each body link in `missing`. */
function withLinkClaims(content: string, missing: readonly string[]): string {
  return updateKnowledgeMetadata(content, (document) => {
    const claims = editableMetadataNode(document, "claims")
    if (claims == null)
      document.set(
        "claims",
        missing.map((to) => ({ to })),
      )
    else {
      if (!isSeq(claims)) throw new Error("Knowledge claims must be a sequence")
      for (const to of missing) claims.add(document.createNode({ to }))
    }
  })
}

/**
 * The file with no claim that lacks an `evidence` mapping. Before CTX-1100,
 * this job added such claims to files that ingestion v2 owns. Each later v2
 * edit that kept one failed. `claims` is the parsed list: its items are in
 * the order of the YAML sequence, and `claimHasEvidence` decides for both
 * the count and this edit.
 */
function withoutClaimsLackingEvidence(
  content: string,
  claims: unknown,
): string {
  const keep = Array.isArray(claims) ? claims.map(claimHasEvidence) : []
  return updateKnowledgeMetadata(content, (document) => {
    const node = editableMetadataNode(document, "claims")
    if (isSeq(node))
      node.items = node.items.filter((_, index) => keep[index] ?? true)
  })
}

export function validFromPersistFiles(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  units: readonly HydrateUnit[]
  introducingCommitTimestamp: string
}): Array<{ path: string; content: string }> {
  const byPath = new Map(input.units.map((unit) => [unit.path, unit]))
  const out: Array<{ path: string; content: string }> = []
  for (const file of input.files) {
    const unit = byPath.get(file.path)
    if (!unit?.claims.some(claimNeedsValidFrom)) continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    out.push({
      path: file.path,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const claims = editableMetadataNode(document, "claims")
        if (!isSeq(claims))
          throw new Error("Knowledge claims must be a sequence")
        for (let index = 0; index < claims.items.length; index++) {
          let claim = claims.items[index]
          if (isAlias(claim)) {
            const detached = materializeMetadataAlias(document, claim)
            claims.items[index] = detached
            claim = detached
          }
          if (!isMap(claim)) continue
          const to = claim.get("to")
          if (typeof to !== "string" || !to.trim()) continue
          const validFrom = claim.get("valid_from")
          if (
            typeof validFrom === "string" &&
            validFrom &&
            !looksLikeGitSha(validFrom)
          )
            continue
          claim.set("valid_from", input.introducingCommitTimestamp)
        }
      }),
    })
  }
  return out
}

function stripImportKeyFromMarkdown(markdown: string): string | null {
  const parsed = parseSimpleFrontMatter(markdown)
  if (parsed.malformed || !Object.hasOwn(parsed.attributes, "import_key"))
    return null
  return updateKnowledgeMetadata(markdown, (document) => {
    removeMetadataKey(document, "import_key")
  })
}

export function importKeyCleanupFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  for (const file of files) {
    if (!file.path.startsWith("knowledge/") || !file.path.endsWith(".md")) {
      continue
    }
    const next = stripImportKeyFromMarkdown(file.content)
    if (next != null && next !== file.content) {
      out.push({ path: file.path, content: next })
    }
  }
  return out
}

export function importKeyCleanupRemainder(
  files: ReadonlyArray<{ path: string; content: string }>,
): number {
  return importKeyCleanupFiles(files).length
}
