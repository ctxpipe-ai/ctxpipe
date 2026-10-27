import { listEvals, runEvals } from "./evals.mjs"
import { listVitest, runVitest } from "./lanes.mjs"
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

export async function listChecks() {
  const lists = await Promise.all([
    listVitest(),
    listStorybook(),
    listEvals(),
    listProjects(),
  ])
  const checks = lists.flat()
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { schemaVersion: 1, checks }
}
