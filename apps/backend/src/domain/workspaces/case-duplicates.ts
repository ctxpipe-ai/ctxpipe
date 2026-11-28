import { type SQLWrapper, sql } from "drizzle-orm"

import { type HydrateUnit, resolveHydrateLink } from "./hydrate.js"
import { WORKSPACE_LINK_SCHEME } from "./mirror-units.js"

/*
 * Case duplicates (CTX-1697, ADR-071 decision 5). Two paths of a Git tree
 * that are equal after case folding are one file on a checkout that ignores
 * case (macOS, Windows). Git keeps both, and a person or an outside agent
 * can commit both, so ctxpipe cannot prevent them. The readers show one
 * copy of each folded path: the copy that Git changed last. A link to the
 * other copy goes to the copy that the read shows.
 */

/** The folded form of a path: NFC, then lowercase. */
export function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase()
}

/** {@link foldPath} of a text column of Postgres. */
export const foldedPathSql = (column: SQLWrapper) =>
  sql`lower(normalize(${column}, NFC))`

/** The count of paths that a read does not show: each copy after the first. */
export function caseDuplicateCount(paths: Iterable<string>): number {
  let count = 0
  const folded = new Set<string>()
  for (const path of paths) {
    const key = foldPath(path)
    if (folded.has(key)) count += 1
    else folded.add(key)
  }
  return count
}

/**
 * The order of the copies of one folded path, the copy that the read shows
 * first. The knowledge plane uses the same order (`caseOrder` in
 * `knowledge-store.ts`):
 * 1. the newest `updatedAt`: the time that an agent sees (`withGitTimes`,
 *    CTX-1710), for an authored file the last commit that changed the
 *    path; a copy with no time comes last;
 * 2. the canonical path (equal to its folded form);
 * 3. the first path in byte order.
 */
export function compareCopies(
  a: { path: string; updatedAt: string | null },
  b: { path: string; updatedAt: string | null },
): number {
  const time = (value: string | null) =>
    value === null ? Number.NEGATIVE_INFINITY : Date.parse(value)
  return (
    time(b.updatedAt) - time(a.updatedAt) ||
    Number(a.path !== foldPath(a.path)) - Number(b.path !== foldPath(b.path)) ||
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  )
}

/** The groups of two or more paths of `paths` with one folded path. */
export function caseGroups(paths: Iterable<string>): string[][] {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const key = foldPath(path)
    groups.set(key, [...(groups.get(key) ?? []), path])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * The path of each copy that a read hides, to the path of the copy that it
 * shows, for the paths of `paths` that are equal after case folding. The
 * copy that `compareCopies` puts first shows. `updatedAt` gives the time of
 * each path; a path that it does not hold has no time.
 */
export function caseCopies(
  paths: Iterable<string>,
  updatedAt: ReadonlyMap<string, string | null>,
): Map<string, string> {
  const shownPath = new Map<string, string>()
  for (const copies of caseGroups(paths)) {
    const [shown, ...hidden] = copies
      .map((path) => ({ path, updatedAt: updatedAt.get(path) ?? null }))
      .sort(compareCopies)
    for (const copy of hidden) if (shown) shownPath.set(copy.path, shown.path)
  }
  return shownPath
}

/**
 * The units of the old stack with one unit for each folded path (CTX-1697).
 * `shownPath` gives the copies that the reads hide ({@link caseCopies}). Each
 * link and each claim of the units that stay, to the path of a unit that
 * goes or to another case of the path of a unit, goes to that unit: a link
 * can still name a copy that a repair removed.
 */
export function hideCaseDuplicateUnits(
  units: HydrateUnit[],
  shownPath: ReadonlyMap<string, string>,
): HydrateUnit[] {
  const kept = units.filter((unit) => !shownPath.has(unit.path))
  const exact = new Set(kept.map((unit) => unit.path))
  const byFold = new Map(kept.map((unit) => [foldPath(unit.path), unit.path]))
  const retargeted = kept.map((unit) => {
    const dir = unit.path.split("/").slice(0, -1).join("/")
    const retarget = (href: string) => {
      const target = resolveHydrateLink(dir, href)
      if (!target || exact.has(target)) return href
      const shown = byFold.get(foldPath(target))
      return shown ? `${WORKSPACE_LINK_SCHEME}${shown}` : href
    }
    return {
      ...unit,
      links: unit.links.map(retarget),
      claims: unit.claims.map((claim) => ({
        ...claim,
        to: retarget(claim.to),
      })),
      ...(unit.linkValidFrom && {
        linkValidFrom: Object.fromEntries(
          Object.entries(unit.linkValidFrom).map(([path, time]) => [
            exact.has(path) ? path : (byFold.get(foldPath(path)) ?? path),
            time,
          ]),
        ),
      }),
    }
  })
  return retargeted
}
