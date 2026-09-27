/**
 * Claim-evidence `sourceId` convention (ADR-033):
 *
 *   `${extractor}:${repositoryId}:${...segments}:${targetHash}`
 *
 * Two subsystems depend on this shape:
 * - `deriveLogicalSourceKey` strips a *trailing* `:${targetHash}` so evidence from
 *   re-ingests at new commits dedupes onto one logical row.
 * - Retraction and repository purge select evidence by a `:${repositoryId}:` needle
 *   and a `(^|:)path(:|$)` segment regex, so the repository id and any warehouse
 *   path must appear as their own colon-delimited segments.
 *
 * A claim extracted in one repository *about* another (context-repo PR mirror →
 * source-repo File) passes both repository ids as segments so deleting either
 * repository purges it.
 */
export function buildEvidenceSourceId(input: {
  extractor: string
  repositoryId: string
  segments: ReadonlyArray<string>
  targetHash: string
}): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.extractor)) {
    throw new Error(`Invalid evidence extractor name "${input.extractor}"`)
  }
  if (input.repositoryId.length === 0 || input.repositoryId.includes(":")) {
    throw new Error(`Invalid evidence repositoryId "${input.repositoryId}"`)
  }
  if (input.targetHash.length === 0 || input.targetHash.includes(":")) {
    throw new Error(`Invalid evidence targetHash "${input.targetHash}"`)
  }
  for (const segment of input.segments) {
    if (segment.length === 0) {
      throw new Error("Evidence source id segments must not be empty")
    }
  }
  return [
    input.extractor,
    input.repositoryId,
    ...input.segments,
    input.targetHash,
  ].join(":")
}

/** True when `sourceId` follows the convention for this repository and hash. */
export function isConventionalEvidenceSourceId(
  sourceId: string,
  repositoryId: string,
  targetHash: string,
): boolean {
  return (
    sourceId.endsWith(`:${targetHash}`) &&
    sourceId.includes(`:${repositoryId}:`) &&
    !sourceId.startsWith(":")
  )
}
