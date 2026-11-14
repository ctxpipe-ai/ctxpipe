// Rejects an entry of the unstable screenshot list
// (scripts/ci/visual-unstable-stories.json) that has no valid `since` date,
// or whose date is more than 7 days before today. An entry removes the
// screenshot check of its story, so its ticket must fix the story soon.
//
// The result depends on the date, so the check manifest marks this check
// `cacheable: false`: a stored pass is never reused.
//
// Usage: node scripts/ci/check-unstable-list.mjs [repository root]

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The entries without a valid `since` date, or with a date more than 7 days
// before `today` (YYYY-MM-DD).
export const overdueEntries = (stories, today) =>
  stories.filter(
    (entry) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.since ?? "") ||
      // A date that does not exist (2026-11-31) is not a date.
      new Date(Date.parse(entry.since) || 0).toISOString().slice(0, 10) !==
        entry.since ||
      Date.parse(today) - Date.parse(entry.since) > 7 * 86_400_000,
  )

function main() {
  const root = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
  )
  const { stories } = JSON.parse(
    readFileSync(join(root, "scripts/ci/visual-unstable-stories.json"), "utf8"),
  )
  const overdue = overdueEntries(stories, new Date().toISOString().slice(0, 10))
  if (overdue.length === 0) return
  console.error(
    `Unstable screenshot entries older than 7 days, or without a date. Fix the story of each entry (its ticket) and remove the entry:\n${overdue
      .map(
        (entry) =>
          `  ${entry.id} (${entry.ticket}, since ${entry.since ?? "no date"})`,
      )
      .join("\n")}`,
  )
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
