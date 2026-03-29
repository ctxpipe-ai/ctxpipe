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
 * Replace every occurrence of `fromNorm` in `text`.
 * Mirrors PostgreSQL `regexp_replace(text, regexp_quote(fromNorm), toNorm, 'g')` used in
 * ingestion retraction UPDATEs (`regexp_quote` requires PostgreSQL 15+).
 */
export function replaceAllQuotedPathSegments(
  text: string,
  fromNorm: string,
  toNorm: string,
): string {
  if (fromNorm.length === 0) return text
  return text.replace(new RegExp(escapeRegex(fromNorm), "g"), toNorm)
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
  return segments.some((s) => s === normPath)
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
