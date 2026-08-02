import { lstat } from "node:fs/promises"
import { basename, join } from "node:path"
import { resolveSafePath } from "./paths.js"

/** Segments that should never appear in glob results (vendor / VCS / build). */
const ANY_SEGMENT_SKIP = new Set([
  ".git",
  "node_modules",
  "third_party",
  "third-party",
  "godeps",
  "bower_components",
  "jspm_packages",
  "pods",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
])

const ROOT_ONLY_SKIP = new Set(["external"])

const DEFAULT_LIMIT = 50_000
const HARD_MAX_LIMIT = 50_000

export type GlobFileEntry = {
  name: string
  path: string
  type: "file" | "dir"
}

export type GlobFilesOptions = {
  /** Absolute path to the repository checkout root. */
  checkoutRoot: string
  /** Glob pattern relative to `path` (cwd). */
  pattern: string
  /** Repo-relative directory to use as Bun Glob cwd. */
  path?: string
  /** When true, only files are returned. Default false (include directories). */
  onlyFiles?: boolean
  /** When true, match dot-prefixed path segments. Default true. */
  dot?: boolean
  /** Max entries to return. Capped at {@link HARD_MAX_LIMIT}. */
  limit?: number
}

export type GlobFilesResult = {
  entries: GlobFileEntry[]
  truncated: boolean
  matched: number
}

/**
 * True when a repo-relative path sits under a vendored / dependency / VCS tree.
 * Aligns with backend `isUnderDependencyVendorPath` plus common build/VCS dirs.
 */
export function isSkippedGlobPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  const segments = normalized.split("/").filter(Boolean)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]?.toLowerCase()
    if (!seg) continue
    const parent = i > 0 ? segments[i - 1]?.toLowerCase() : null
    if (ANY_SEGMENT_SKIP.has(seg)) return true
    if (ROOT_ONLY_SKIP.has(seg) && i === 0) return true
    if (seg === "vendor" && parent !== "internal") return true
  }
  return false
}

export function resolveGlobLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), HARD_MAX_LIMIT)
}

/**
 * Scan a checkout with Bun.Glob and return typed, repo-relative entries.
 */
export async function globFilesInCheckout(
  options: GlobFilesOptions,
): Promise<GlobFilesResult> {
  const onlyFiles = options.onlyFiles ?? false
  const dot = options.dot ?? true
  const limit = resolveGlobLimit(options.limit)
  const relativeCwd = (options.path ?? "").replace(/\\/g, "/").replace(/^\//, "")

  const absCwd = relativeCwd
    ? resolveSafePath(options.checkoutRoot, relativeCwd)
    : resolveSafePath(options.checkoutRoot, ".")

  // Ensure cwd exists and is a directory (not a file / missing path).
  const cwdStat = await lstat(absCwd)
  if (!cwdStat.isDirectory()) {
    throw new Error("Path is not a directory")
  }

  // Codesearch runs on Bun. Use the Bun global (not `import from "bun"`) so Node
  // vitest can still load this module for route/error-path tests.
  if (typeof Bun === "undefined" || typeof Bun.Glob !== "function") {
    throw new Error("Bun.Glob is required for repository glob scanning")
  }
  const glob = new Bun.Glob(options.pattern)
  const entries: GlobFileEntry[] = []
  let matched = 0

  for await (const rel of glob.scan({
    cwd: absCwd,
    onlyFiles,
    dot,
    followSymlinks: false,
  })) {
    const normalizedRel = rel.replace(/\\/g, "/")
    const repoPath = relativeCwd
      ? `${relativeCwd}/${normalizedRel}`
      : normalizedRel

    if (isSkippedGlobPath(repoPath)) continue

    const absPath = join(absCwd, normalizedRel)
    let type: "file" | "dir"
    try {
      const st = await lstat(absPath)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (onlyFiles) continue
        type = "dir"
      } else if (st.isFile()) {
        type = "file"
      } else {
        continue
      }
    } catch {
      continue
    }

    matched += 1
    if (entries.length < limit) {
      entries.push({
        name: basename(normalizedRel),
        path: repoPath,
        type,
      })
    }
  }

  return {
    entries,
    truncated: matched > entries.length,
    matched,
  }
}
