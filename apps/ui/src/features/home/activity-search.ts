/**
 * The Home activity view in the URL search params, so a reload keeps it.
 * `scope` is a workspace slug or `*` (all workspaces). `day` is the heatmap
 * day. `since` and `until` are the date range. All days are UTC
 * (`YYYY-MM-DD`).
 */
export type ActivitySearch = {
  scope?: string
  author?: string
  day?: string
  since?: string
  until?: string
}

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/

function text(value: unknown): string | undefined {
  // The router parses `?author=123` as a number.
  if (typeof value === "number") return String(value)
  return typeof value === "string" && value !== "" ? value : undefined
}

function utcDay(value: unknown): string | undefined {
  return typeof value === "string" && UTC_DAY.test(value) ? value : undefined
}

/** The activity params of a search object. Other params are ignored. */
export function activitySearch(
  search: Record<string, unknown>,
): ActivitySearch {
  return {
    scope: text(search.scope),
    author: text(search.author),
    day: utcDay(search.day),
    since: utcDay(search.since),
    until: utcDay(search.until),
  }
}

/** A stable key of the activity params (for `useUrgentValue`). */
export function activitySearchKey(search: ActivitySearch): string {
  return JSON.stringify([
    search.scope,
    search.author,
    search.day,
    search.since,
    search.until,
  ])
}

/** The UTC day `days` days before today (`0`: today). */
export function utcDayBefore(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}
