import { isAlias, isMap, isSeq } from "yaml"
import { folderMapMarkerState, maintainFolderMap } from "./folder-map.js"
import { type HydrateUnit, resolveHydrateLink } from "./hydrate.js"
import { looksLikeGitSha } from "./hydrate-phases.js"
import {
  editableMetadataNode,
  removeMetadataKey,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import { parseSimpleFrontMatter } from "./layout.js"
import { renameRewriteRemainder } from "./rename-rewrite.js"
import {
  shouldEnqueueAfterHydrate,
  shouldEnqueueWorkspaceWriteJob,
  type WorkspaceWriteJobKind,
} from "./write-jobs.js"

function missingClaimLinks(unit: HydrateUnit): string[] {
  const directory = unit.path.split("/").slice(0, -1).join("/")
  const targets = new Set(
    unit.claims.map((claim) => resolveHydrateLink(directory, claim.to)),
  )
  return unit.links.filter((link) => {
    const target = resolveHydrateLink(directory, link)
    if (!target || targets.has(target)) return false
    targets.add(target)
    return true
  })
}

export function claimsUpgradeRemainder(units: readonly HydrateUnit[]): number {
  return units.filter((unit) => missingClaimLinks(unit).length > 0).length
}

export function validFromPersistRemainder(
  units: readonly HydrateUnit[],
): number {
  return units.filter((unit) =>
    unit.claims.some(
      (claim) => !claim.validFrom || looksLikeGitSha(claim.validFrom),
    ),
  ).length
}

export function opsFolderMapRemainder(agentsMd: string | null): number {
  if (!agentsMd?.trim()) return 1
  return folderMapMarkerState(agentsMd) === "valid" ? 0 : 1
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
  if (!gate.enqueue && gate.reason === "stale_generation") return []
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
    if (missing.length === 0) continue
    const parsed = parseSimpleFrontMatter(file.content)
    if (parsed.malformed) continue
    out.push({
      path: file.path,
      content: updateKnowledgeMetadata(file.content, (document) => {
        const claims = editableMetadataNode(document, "claims")
        if (claims == null)
          document.set(
            "claims",
            missing.map((to) => ({ to })),
          )
        else {
          if (!isSeq(claims))
            throw new Error("Knowledge claims must be a sequence")
          for (const to of missing) claims.add(document.createNode({ to }))
        }
      }),
    })
  }
  return out
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
    if (
      !unit ||
      !unit.claims.some(
        (claim) => !claim.validFrom || looksLikeGitSha(claim.validFrom),
      )
    ) {
      continue
    }
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
            const detached = document.createNode(claim.toJS(document))
            detached.comment = claim.comment
            detached.commentBefore = claim.commentBefore
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

export function stripImportKeyFromMarkdown(markdown: string): string | null {
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
  requestedDisplayName?: string
  paths: readonly string[]
}): Array<{ path: string; content: string }> {
  const content = maintainFolderMap({
    displayName: input.displayName,
    existing: input.existingAgentsMd,
    requestedDisplayName: input.requestedDisplayName,
    paths: input.paths,
  })
  if (input.existingAgentsMd === content) return []
  return [{ path: "AGENTS.md", content }]
}
