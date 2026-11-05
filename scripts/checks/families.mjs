import { readFileSync } from "node:fs"

import { listEvals, runEvals } from "./evals.mjs"
import { listVitest, runVitest } from "./lanes.mjs"
import { withNeeds } from "./prerequisites.mjs"
import { listProjects, runProjects } from "./projects.mjs"
import { listStorybook, runStorybook } from "./storybook.mjs"

// Each check family: how it lists its checks and how it runs them. A runner
// takes the checks of its family (and the trace directory, if any) and
// returns `{ records, traced?, traceFailed? }`.
export const runners = {
  vitest: runVitest,
  storybook: runStorybook,
  eval: runEvals,
  typecheck: runProjects,
  lint: runProjects,
  policy: runProjects,
  build: runProjects,
  deploy: runProjects,
}

// The checks with `portable` removed from each id in `denied`.
export const markPortable = (checks, denied) =>
  checks.map(({ portable, ...check }) =>
    portable && !denied.has(check.id) ? { ...check, portable } : check,
  )

export async function listChecks() {
  const lists = await Promise.all([
    listVitest(),
    listStorybook(),
    listEvals(),
    listProjects(),
  ])
  // The checks that the nightly audit found not portable: their result
  // differed between platforms (the factory store report, NOT PORTABLE).
  const denied = new Set(
    JSON.parse(
      readFileSync(new URL("non-portable.json", import.meta.url), "utf8"),
    ),
  )
  const checks = markPortable(lists.flat(), denied).map((check) =>
    check.prerequisites
      ? { ...check, prerequisites: withNeeds(check.prerequisites) }
      : check,
  )
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { schemaVersion: 1, checks }
}
