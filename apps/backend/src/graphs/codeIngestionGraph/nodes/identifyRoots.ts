import { getLogger } from "../../../observability/logger.js"
import type { CodeIngestionState } from "../schemas.js"
import { identifyRootsAmbiguousAgent } from "./identifyRootsAmbiguousAgent.js"
import { deterministicDetectRoots } from "./identifyRootsDeterministic.js"
import { narrowRootsForPartialDiff } from "./narrowRootsForPartialDiff.js"

function hasPartialDiffPaths(state: CodeIngestionState): boolean {
  const changed = state.changedPaths?.length ?? 0
  const deleted = state.deletedPaths?.length ?? 0
  const renames = state.renames?.length ?? 0
  return changed + deleted + renames > 0
}

export async function identifyRoots(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, targetHash } = state
  const deterministic = await deterministicDetectRoots(state)

  let resolved: string[]
  let rootSource:
    | "deterministic"
    | "llm"
    | "partialRoots"
    | "repoRoot"
  let defaultedToRepoRoot = false

  if (deterministic.decision === "confident") {
    resolved = deterministic.roots
    rootSource = "deterministic"
  } else {
    const fallback = await identifyRootsAmbiguousAgent({
      state,
      partialRoots: deterministic.partialRoots,
      reason: deterministic.reason,
    })
    resolved = fallback.roots
    rootSource = fallback.source
    defaultedToRepoRoot = fallback.source === "repoRoot"
  }

  if (state.ingestMode === "partial" && hasPartialDiffPaths(state)) {
    const narrowed = narrowRootsForPartialDiff(
      resolved,
      state.changedPaths,
      state.deletedPaths,
      state.renames,
    )
    if (narrowed.length > 0) {
      const logger = getLogger()
      logger.set({
        step: "codeIngestion.identifyRoots.summary",
        repositoryId,
        targetHash,
        rootsCount: narrowed.length,
        roots: narrowed,
        defaultedToRepoRoot,
        rootSource,
      })
      logger.info("identifyRoots summary")
      return { roots: narrowed }
    }

    const warnLogger = getLogger()
    warnLogger.warn(
      "identifyRoots: partial diff matched no monorepo roots; falling back to agent/default roots",
      {
        repositoryId,
        targetHash,
        resolvedRoots: resolved,
        changedPaths: state.changedPaths,
        deletedPaths: state.deletedPaths,
        renames: state.renames,
        rootSource,
      },
    )
  }

  const logger = getLogger()
  logger.set({
    step: "codeIngestion.identifyRoots.summary",
    repositoryId,
    targetHash,
    rootsCount: resolved.length,
    roots: resolved,
    defaultedToRepoRoot,
    rootSource,
  })
  logger.info("identifyRoots summary")

  return { roots: resolved }
}
