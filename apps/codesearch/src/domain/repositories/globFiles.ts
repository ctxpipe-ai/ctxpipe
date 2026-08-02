import { lstat } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { resolveSafePath } from "./paths.js"

export class GlobPathNotFoundError extends Error {
  constructor(message = "Path not found") {
    super(message)
    this.name = "GlobPathNotFoundError"
  }
}

export class GlobInvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GlobInvalidRequestError"
  }
}

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
 * Reject patterns that can escape the checkout cwd (`..`, absolute paths).
 */
export function assertSafeGlobPattern(pattern: string): void {
  const normalized = pattern.replace(/\\/g, "/")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new GlobInvalidRequestError("Invalid glob pattern")
  }
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new GlobInvalidRequestError("Invalid glob pattern")
    }
  }
}

function assertAbsPathWithinCheckout(
  checkoutRoot: string,
  absPath: string,
): void {
  const base = resolve(checkoutRoot)
  const full = resolve(absPath)
  if (full !== base && !full.startsWith(`${base}${sep}`)) {
    throw new GlobInvalidRequestError("Path traversal is not allowed")
  }
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
  assertSafeGlobPattern(options.pattern)

  let absCwd: string
  try {
    absCwd = relativeCwd
      ? resolveSafePath(options.checkoutRoot, relativeCwd)
      : resolveSafePath(options.checkoutRoot, ".")
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Path traversal is not allowed"
    ) {
      throw new GlobInvalidRequestError("Path traversal is not allowed")
    }
    throw error
  }

  // Ensure cwd exists and is a directory (not a file / missing path).
  let cwdStat: Awaited<ReturnType<typeof lstat>>
  try {
    cwdStat = await lstat(absCwd)
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : ""
    if (code === "ENOENT") {
      throw new GlobPathNotFoundError()
    }
    throw error
  }
  if (!cwdStat.isDirectory()) {
    throw new GlobPathNotFoundError("Path is not a directory")
  }

  // Codesearch runs on Bun. Use the Bun global (not `import from "bun"`) so Node
  // vitest can still load this module for route/error-path tests.
  if (typeof Bun === "undefined" || typeof Bun.Glob !== "function") {
    throw new Error("Bun.Glob is required for repository glob scanning")
  }
  const checkoutRootAbs = resolve(options.checkoutRoot)
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
    if (
      normalizedRel.split("/").some((segment) => segment === "..") ||
      normalizedRel.startsWith("/")
    ) {
      continue
    }
    const repoPath = relativeCwd
      ? `${relativeCwd}/${normalizedRel}`
      : normalizedRel

    if (isSkippedGlobPath(repoPath)) continue

    let absPath: string
    try {
      absPath = resolveSafePath(checkoutRootAbs, repoPath)
    } catch {
      continue
    }
    assertAbsPathWithinCheckout(checkoutRootAbs, absPath)

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
