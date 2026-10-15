import { posix, win32 } from "node:path"
import { log } from "../../observability/logger.js"
import type { HydrateClaim } from "./hydrate.js"
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

type Unit = {
  path: string
  kind?: string | null
  attributes: Record<string, unknown>
}

type Target = { path: string; root: string | null }

export function pullRequestChangedClaims(
  units: readonly Unit[],
): Map<string, HydrateClaim[]> {
  let invalidRoots = 0
  const targets = new Map<string, Target[]>()
  for (const unit of units) {
    const isPackage = PACKAGE_KINDS.has(unit.kind ?? "")
    if (!isPackage && unit.kind !== "Repository") continue
    if (isPackage && unit.attributes.generated_by !== "ctxpipe-extract")
      continue
    if (
      isPackage &&
      (!Array.isArray(unit.attributes.sources) ||
        unit.attributes.sources.length !== 1)
    )
      continue
    const root = isPackage ? sourceRoot(unit.attributes.root) : null
    if (isPackage && root === null) {
      if (unit.attributes.root !== undefined) invalidRoots++
      continue
    }
    for (const source of stringList(unit.attributes.sources)) {
      const key = normalizeWorkspaceRepositoryUrl(source)
      const list = targets.get(key) ?? []
      list.push({ path: unit.path, root })
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
  for (const unit of units) {
    if (unit.kind !== "PullRequest") continue
    const pull = mergedPullRequest(unit.attributes)
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
      unit.path,
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
