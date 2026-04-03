/**
 * Path helpers for partial-ingestion retraction against colon-delimited
 * `logical_source_key` / `source_id` values (see extractors under codeIngestionGraph).
 */

/** Normalize git-style paths to forward slashes and trim redundant ./ */
export function normalizeGitPath(path: string): string {
  let p = path.replace(/\\/g, "/").trim()
  if (p.startsWith("./")) {
    p = p.slice(2)
  }
  while (p.startsWith("/")) {
    p = p.slice(1)
  }
  return p
}

/** Escape a string for use inside a JavaScript RegExp (not PostgreSQL). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rename `fromNorm` → `toNorm` only when a colon-delimited segment equals `fromNorm`
 * (after {@link normalizeGitPath} per segment). Avoids substring collisions (e.g. `src/a`
 * vs `src/a.ts` in different segments).
 */
export function renamePathSegmentInColonDelimitedKey(
  text: string,
  fromNorm: string,
  toNorm: string,
): string {
  const from = normalizeGitPath(fromNorm)
  const to = normalizeGitPath(toNorm)
  if (from.length === 0) return text
  return text
    .split(":")
    .map((seg) => (normalizeGitPath(seg) === from ? to : seg))
    .join(":")
}

/**
 * Replace every colon-delimited path segment equal to `fromNorm` with `toNorm`.
 * Mirrors PostgreSQL segment `regexp_replace` used in {@link retractIngestionForDiffPg}.
 */
export function replaceAllQuotedPathSegments(
  text: string,
  fromNorm: string,
  toNorm: string,
): string {
  return renamePathSegmentInColonDelimitedKey(text, fromNorm, toNorm)
}

/**
 * True when `path` appears as a full colon-delimited segment in `key`
 * (e.g. identifyAPIs:repo:root:src/a.ts:hash → segment `src/a.ts`).
 */
export function evidenceKeyMatchesPathSegment(
  path: string,
  key: string,
): boolean {
  const normPath = normalizeGitPath(path)
  if (normPath.length === 0) return false
  const segments = key.replace(/\\/g, "/").split(":")
  return segments.some((s) => normalizeGitPath(s) === normPath)
}

/**
 * Replace the first occurrence of `from` in `value` (used for rename propagation).
 */
export function replaceFirstOccurrence(
  value: string,
  from: string,
  to: string,
): string {
  if (from.length === 0) return value
  const idx = value.indexOf(from)
  if (idx === -1) return value
  return value.slice(0, idx) + to + value.slice(idx + from.length)
}
