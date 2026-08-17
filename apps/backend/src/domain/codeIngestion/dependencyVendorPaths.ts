/**
 * Language-agnostic path segments for local copies of external dependencies.
 * Used to skip instruction extraction under vendored trees (Go vendor/, node_modules/, etc.).
 *
 * Matching uses ecosystem conventions per segment (case-insensitive exact segment names).
 * `vendor-portal` does not match `vendor`.
 *
 * Intentionally excluded (ambiguous or internal monorepo layout):
 * - `packages` — workspace packages (e.g. this repo's packages/)
 * - `deps`, `lib` — too generic
 */
/** Nested placement is normal — match at any depth. */
const ANY_SEGMENT_DIRS = new Set([
  "node_modules",
  "third_party",
  "third-party",
  "godeps",
  "bower_components",
  "jspm_packages",
  "pods",
])

/** Bazel-style; only the workspace-root `external/` tree. */
const ROOT_ONLY_DIRS = new Set(["external"])

export function isUnderDependencyVendorPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  const segments = normalized.split("/").filter(Boolean)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]?.toLowerCase()
    if (!seg) continue
    const parent = i > 0 ? segments[i - 1]?.toLowerCase() : null

    if (ANY_SEGMENT_DIRS.has(seg)) return true
    if (ROOT_ONLY_DIRS.has(seg) && i === 0) return true
    // Go/Composer/Rust vendor/ at module root; not Go's first-party `internal/` packages.
    if (seg === "vendor" && parent !== "internal") return true
  }
  return false
}
