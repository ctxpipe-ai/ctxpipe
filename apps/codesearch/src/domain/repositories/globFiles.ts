import { lstat, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
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
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new GlobInvalidRequestError("Invalid glob pattern")
  }
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new GlobInvalidRequestError("Invalid glob pattern")
    }
  }
}

function errnoCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code)
  }
  return ""
}

async function assertCheckoutDirectory(absCwd: string): Promise<void> {
  let cwdStat: Awaited<ReturnType<typeof lstat>>
  try {
    cwdStat = await lstat(absCwd)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new GlobPathNotFoundError()
    }
    throw error
  }
  if (!cwdStat.isDirectory()) {
    throw new GlobPathNotFoundError("Path is not a directory")
  }
}

function resolveCheckoutCwd(checkoutRoot: string, relativeCwd: string): string {
  try {
    return relativeCwd
      ? resolveSafePath(checkoutRoot, relativeCwd)
      : resolveSafePath(checkoutRoot, ".")
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Path traversal is not allowed"
    ) {
      throw new GlobInvalidRequestError("Path traversal is not allowed")
    }
    throw error
  }
}

/**
 * Recursive checkout walk that never descends into skipped vendor / VCS / build
 * directories. Uses dirent types (no per-file lstat).
 */
async function walkPrunedCheckout(input: {
  absCwd: string
  relativeCwd: string
  onlyFiles: boolean
  dot: boolean
  visit: (entry: GlobFileEntry) => "continue" | "stop"
}): Promise<void> {
  const stack: Array<{ absDir: string; repoPrefix: string }> = [
    { absDir: input.absCwd, repoPrefix: input.relativeCwd },
  ]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    let dirents: Awaited<ReturnType<typeof readdir>>
    try {
      dirents = await readdir(current.absDir, { withFileTypes: true })
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        if (current.absDir === input.absCwd) {
          throw new GlobPathNotFoundError()
        }
        continue
      }
      throw error
    }

    for (const dirent of dirents) {
      const name = dirent.name
      if (!input.dot && name.startsWith(".")) continue
      const repoPath = current.repoPrefix
        ? `${current.repoPrefix}/${name}`
        : name
      if (isSkippedGlobPath(repoPath)) continue
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (!input.onlyFiles) {
          if (input.visit({ name, path: repoPath, type: "dir" }) === "stop") {
            return
          }
        }
        stack.push({
          absDir: join(current.absDir, name),
          repoPrefix: repoPath,
        })
        continue
      }
      if (!dirent.isFile()) continue
      if (input.visit({ name, path: repoPath, type: "file" }) === "stop") {
        return
      }
    }
  }
}

/** File paths under a checkout, skipping vendor / VCS / build trees. */
export async function listCheckoutFilePaths(
  checkoutRoot: string,
  options?: { limit?: number },
): Promise<string[]> {
  const limit = resolveGlobLimit(options?.limit)
  const absCwd = resolveCheckoutCwd(checkoutRoot, "")
  await assertCheckoutDirectory(absCwd)
  const paths: string[] = []
  await walkPrunedCheckout({
    absCwd,
    relativeCwd: "",
    onlyFiles: true,
    dot: true,
    visit: (entry) => {
      if (paths.length >= limit) return "stop"
      paths.push(entry.path)
      return "continue"
    },
  })
  return paths
}

/**
 * Scan a checkout and return typed, repo-relative entries.
 * Walks the working tree and prunes skip dirs before matching the glob.
 */
export async function globFilesInCheckout(
  options: GlobFilesOptions,
): Promise<GlobFilesResult> {
  const onlyFiles = options.onlyFiles ?? false
  const dot = options.dot ?? true
  const limit = resolveGlobLimit(options.limit)
  const relativeCwd = (options.path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\//, "")
  assertSafeGlobPattern(options.pattern)
  const absCwd = resolveCheckoutCwd(options.checkoutRoot, relativeCwd)
  await assertCheckoutDirectory(absCwd)

  // Codesearch runs on Bun. Use the Bun global (not `import from "bun"`) so Node
  // vitest can still load this module for route/error-path tests.
  if (typeof Bun === "undefined" || typeof Bun.Glob !== "function") {
    throw new Error("Bun.Glob is required for repository glob scanning")
  }
  const glob = new Bun.Glob(options.pattern)
  const entries: GlobFileEntry[] = []
  let matched = 0
  let truncated = false

  await walkPrunedCheckout({
    absCwd,
    relativeCwd,
    onlyFiles,
    dot,
    visit: (entry) => {
      const relForMatch = relativeCwd
        ? entry.path.slice(relativeCwd.length + 1)
        : entry.path
      if (
        relForMatch.split("/").some((segment) => segment === "..") ||
        relForMatch.startsWith("/") ||
        !glob.match(relForMatch)
      ) {
        return "continue"
      }
      matched += 1
      if (entries.length < limit) {
        entries.push({
          name: basename(relForMatch),
          path: entry.path,
          type: entry.type,
        })
        return "continue"
      }
      truncated = true
      return "stop"
    },
  })

  return {
    entries,
    truncated,
    matched,
  }
}
