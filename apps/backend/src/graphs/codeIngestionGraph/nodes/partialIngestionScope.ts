/**
 * Helpers for partial ingestion: limit identify/extract work to diff-relevant paths.
 */
import { isConnectorMirrorPath } from "../../../domain/codeIngestion/connectorMirrorPaths.js"
import type { CodeIngestionState } from "../schemas.js"
import { stripLeadingDotSlash } from "./narrowRootsForPartialDiff.js"

/** True when partial ingest has diff metadata (including deletes-only). */
export function hasPartialIngestDiff(state: CodeIngestionState): boolean {
  if (state.ingestMode !== "partial") return false
  const c = state.changedPaths?.length ?? 0
  const d = state.deletedPaths?.length ?? 0
  const r = state.renames?.length ?? 0
  return c + d + r > 0
}

/**
 * Deletes-only partial ingest: nothing new to scan on disk; retraction handled elsewhere.
 */
export function shouldSkipExtractorForPartialDeletesOnly(
  state: CodeIngestionState,
): boolean {
  if (state.ingestMode !== "partial") return false
  const hasChanged = (state.changedPaths?.length ?? 0) > 0
  const hasRenames = (state.renames?.length ?? 0) > 0
  return !hasChanged && !hasRenames && (state.deletedPaths?.length ?? 0) > 0
}

/**
 * Partial ingest where every changed, deleted and renamed path is connector
 * warehouse content (`github/`, `linear/`, `slack/`, …). Code extractors
 * (extractKind, identify_*, instruction units) have nothing to learn from those
 * paths; only the connector extractors and the link pass run (ADR-033).
 */
export function isConnectorOnlyPartialDiff(state: CodeIngestionState): boolean {
  if (state.ingestMode !== "partial") return false
  const paths = [
    ...(state.changedPaths ?? []),
    ...(state.deletedPaths ?? []),
    ...(state.renames ?? []).flatMap((r) => [r.from, r.to]),
  ]
  if (paths.length === 0) return false
  return paths.every((p) =>
    isConnectorMirrorPath(stripLeadingDotSlash(p.trim())),
  )
}

/** Code extractors skip deletes-only and connector-only partial diffs. */
export function shouldSkipCodeExtractorForPartialDiff(
  state: CodeIngestionState,
): boolean {
  return (
    shouldSkipExtractorForPartialDeletesOnly(state) ||
    isConnectorOnlyPartialDiff(state)
  )
}

/**
 * Paths that should drive extractor scans (deleted paths are handled in retraction).
 */
export function partialScanPathsForExtractors(
  state: CodeIngestionState,
): string[] {
  const out: string[] = []
  if (state.changedPaths) out.push(...state.changedPaths)
  for (const ren of state.renames ?? []) {
    out.push(ren.from, ren.to)
  }
  return out
}

/**
 * True if `repoRelativePath` is the same as any scan anchor or under it (prefix), or vice versa.
 */
export function repoPathMatchesPartialScan(
  repoRelativePath: string,
  scanPaths: string[],
): boolean {
  if (scanPaths.length === 0) return true
  const p = stripLeadingDotSlash(repoRelativePath.trim())
  for (const sp of scanPaths) {
    const s = stripLeadingDotSlash(sp.trim())
    if (s.length === 0) return true
    if (p === s || p.startsWith(`${s}/`) || s.startsWith(`${p}/`)) return true
  }
  return false
}

export function filterPathsByPartialScan(
  paths: string[],
  scanPaths: string[],
): string[] {
  if (scanPaths.length === 0) return paths
  return paths.filter((p) => repoPathMatchesPartialScan(p, scanPaths))
}

/** Short hint appended to agent system prompts in partial mode. */
export function partialScanPromptSuffix(scanPaths: string[]): string {
  if (scanPaths.length === 0) return ""
  return `\n\nPartial ingestion scope: only inspect paths under or matching these prefixes: ${scanPaths.join(", ")}. Skip unrelated areas.`
}
