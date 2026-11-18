import { posix, win32 } from "node:path"

import { log } from "../../observability/logger.js"
import { type HydrateClaim, sourcePathOf } from "./hydrate.js"
import { WORKSPACE_LINK_SCHEME } from "./mirror-units.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/**
 * `PullRequest CHANGED <unit>` claims from the GitHub pull request mirror
 * (CTX-657). Hydrate matches each changed file of a merged pull request to
 * the package units (Service, App, Library) of the same repository. The
 * host writes `root` on these units; the model never writes it. The deepest
 * root that holds the file wins. A file outside every root changes the
 * Repository unit only. The claim is valid from the merge date.
 */

const PACKAGE_KINDS: ReadonlySet<string> = new Set([
  "Service",
  "App",
  "Library",
])

type Target = { path: string; root: string | null }

/**
 * The data of one unit for the `CHANGED` claims that depends only on its own
 * file. Hydrate stores it in the reference index of the unit.
 */
export type UnitChangeData = {
  /** A package or Repository unit that a pull request can change. */
  target: { root: string | null; sources: string[] } | null
  /** A package unit with a `root` value that is not a root. */
  invalidRoot: boolean
  /** The fields of a merged pull request mirror file. */
  pull: { repositoryUrl: string; mergedAt: string; paths: string[] } | null
}

export function extractChangeData(unit: {
  kind?: string | null
  attributes: Record<string, unknown>
}): UnitChangeData {
  const data: UnitChangeData = {
    target: null,
    invalidRoot: false,
    pull:
      unit.kind === "PullRequest" ? mergedPullRequest(unit.attributes) : null,
  }
  const isPackage = PACKAGE_KINDS.has(unit.kind ?? "")
  if (!isPackage && unit.kind !== "Repository") return data
  if (isPackage && unit.attributes.generated_by !== "ctxpipe-extract")
    return data
  if (
    isPackage &&
    (!Array.isArray(unit.attributes.sources) ||
      unit.attributes.sources.length !== 1)
  )
    return data
  const root = isPackage ? sourceRoot(unit.attributes.root) : null
  if (isPackage && root === null) {
    data.invalidRoot = unit.attributes.root !== undefined
    return data
  }
  data.target = { root, sources: stringList(unit.attributes.sources) }
  return data
}

export function resolveChangedClaims(
  units: ReadonlyArray<{ path: string; change: UnitChangeData }>,
  /**
   * Path of each GitHub source file → its repository URL. A `sources` value
   * is a source path (ADR-050) or, in a unit written before, a URL.
   */
  sourceRepositories: ReadonlyMap<string, string> = new Map(),
): Map<string, HydrateClaim[]> {
  let invalidRoots = 0
  const targets = new Map<string, Target[]>()
  for (const { path: unitPath, change } of units) {
    if (change.invalidRoot) invalidRoots++
    if (!change.target) continue
    const { root } = change.target
    for (const source of change.target.sources) {
      const path = sourcePathOf(source)
      const key =
        (path && sourceRepositories.get(path)) ??
        normalizeWorkspaceRepositoryUrl(source)
      const list = targets.get(key) ?? []
      list.push({ path: unitPath, root })
      targets.set(key, list)
    }
  }

  if (invalidRoots > 0) {
    log.warn({
      step: "pull_request_changes.invalid_root",
      message: "Ignored invalid package roots",
      invalidRoots,
    })
  }

  const claims = new Map<string, HydrateClaim[]>()
  for (const { path: unitPath, change } of units) {
    const pull = change.pull
    if (!pull) continue
    const candidates = targets.get(pull.repositoryUrl) ?? []
    const changed = new Set<string>()
    for (const file of pull.paths) {
      let depth = -1
      let hits: string[] = []
      for (const target of candidates) {
        if (target.root === null || !holds(target.root, file)) continue
        const d = target.root === "" ? 0 : target.root.split("/").length
        if (d > depth) {
          depth = d
          hits = [target.path]
        } else if (d === depth) hits.push(target.path)
      }
      if (!hits.length)
        hits = candidates.filter((t) => t.root === null).map((t) => t.path)
      for (const path of hits) changed.add(path)
    }
    if (!changed.size) continue
    claims.set(
      unitPath,
      [...changed].map((path) => ({
        to: `${WORKSPACE_LINK_SCHEME}${path}`,
        predicate: "CHANGED",
        confidence: 1,
        validFrom: pull.mergedAt,
        validTo: null,
        source: "github",
      })),
    )
  }
  return claims
}

/** `.` names the repository top; null when the value is not a root. */
function sourceRoot(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (
    !value ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value
      .split(/[\\/]/)
      .some((segment) => segment === ".." || segment === ".git")
  )
    return null
  const root = value.replace(/^\.\/+/, "").replace(/\/+$/, "")
  return root === "." ? "" : root
}

function holds(root: string, file: string): boolean {
  return root === "" || file === root || file.startsWith(`${root}/`)
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : []
}

/** The fields of a merged pull request mirror file, else null. */
function mergedPullRequest(attributes: Record<string, unknown>): {
  repositoryUrl: string
  mergedAt: string
  paths: string[]
} | null {
  if (attributes.type !== "pull_request" || attributes.merged !== true)
    return null
  const mergedAt =
    attributes.mergedAt instanceof Date
      ? attributes.mergedAt.toISOString()
      : attributes.mergedAt
  if (typeof mergedAt !== "string" || !mergedAt.trim()) return null
  if (typeof attributes.repository !== "string") return null
  const paths: string[] = []
  for (const row of Array.isArray(attributes.files) ? attributes.files : []) {
    if (!row || typeof row !== "object") continue
    const { path, previousPath } = row as Record<string, unknown>
    for (const value of [path, previousPath])
      if (typeof value === "string" && value) paths.push(value)
  }
  return {
    repositoryUrl: normalizeWorkspaceRepositoryUrl(
      `https://github.com/${attributes.repository}`,
    ),
    mergedAt,
    paths,
  }
}
