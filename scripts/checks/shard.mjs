import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

// Packs check ids into the shards of the CI jobs that run them (the profile
// jobs of the merge gate, scripts/checks/README.md). The selector outputs
// only ids; this public module decides how they run.

// Each profile is one CI job with one setup. `setupMinutes` is the time of a
// shard before its tests start, measured on CI run 40322361899.
// `maxShards` is the shard count of the job in today's full run.
export const profiles = {
  project: { setupMinutes: 0.4, maxShards: 2 },
  node: { setupMinutes: 0.3, maxShards: 1 },
  database: { setupMinutes: 1.4, maxShards: 9 },
  upgrade: { setupMinutes: 1.1, maxShards: 1 },
  codesearch: { setupMinutes: 0.3, maxShards: 1 },
  vercel: { setupMinutes: 0.8, maxShards: 1 },
  storybook: { setupMinutes: 0.6, maxShards: 5 },
}

// A Storybook shard needs the Storybook build job first.
export const storybookBuildMinutes = 1.2

// Where each check runs, by `<family>:<lane>` or else `<family>`: `job` is
// the job of today's full run, `profile` the profile job of a gated run.
// A check without an entry (an eval, the latency check) has its own workflow.
const runsIn = {
  lint: { job: "lint", profile: "project" },
  policy: { job: "lint", profile: "project" },
  typecheck: { job: "typecheck", profile: "project" },
  "storybook:golden": { job: "storybook-golden", profile: "storybook" },
  storybook: { job: "storybook-plays", profile: "storybook" },
  "vitest:backend": { job: "test-shards", profile: "database" },
  "vitest:contracts": { job: "test-shards", profile: "database" },
  "vitest:ui": { job: "package-tests", profile: "node" },
  "vitest:cli": { job: "package-tests", profile: "node" },
  "vitest:aws-cdk": { job: "package-tests", profile: "node" },
  "vitest:upgrade": {
    job: "upgrade-from-previous-release",
    profile: "upgrade",
  },
  "vitest:codesearch": { job: "codesearch", profile: "codesearch" },
  "vitest:codesearch-bun": { job: "codesearch", profile: "codesearch" },
  "vitest:vercel": { job: "vercel-sandbox", profile: "vercel" },
}

// The jobs of today's full run that run a check.
export const checkJobs = new Set(Object.values(runsIn).map((run) => run.job))

// The job and the profile of a check id, or undefined.
export function runsInOf(id) {
  const [family, lane] = id.split(":")
  return runsIn[`${family}:${lane}`] ?? runsIn[family]
}

// The seconds of each check of a trace: the sum of its case times, or its
// entry in `durations` (a check that ran without a trace record).
export function traceSeconds(trace) {
  const seconds = new Map()
  for (const check of trace?.checks ?? [])
    seconds.set(
      check.id,
      check.cases.reduce((sum, item) => sum + item.durationMs, 0) / 1000,
    )
  for (const [id, ms] of Object.entries(trace?.durations ?? {}))
    seconds.set(id, ms / 1000)
  return seconds
}

export function readTrace(path) {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"))
}

const weights = () =>
  JSON.parse(
    readFileSync(new URL("../ci/test-weights.json", import.meta.url), "utf8"),
  )

// The estimated seconds of one check: the trace, then the measured file
// weights of CI (scripts/ci/test-weights.json), then a fixed guess.
export function estimate(id, seconds, fileWeights = weights()) {
  if (seconds.has(id)) return seconds.get(id)
  const [family, lane, ...rest] = id.split(":")
  const file = rest.join(":")
  const directory = { backend: "apps/backend/", contracts: "apps/backend/" }
  const weight = fileWeights[lane]?.[file.replace(directory[lane] ?? "", "")]
  if (weight !== undefined) return weight
  return family === "typecheck" ? 60 : family === "storybook" ? 3 : 10
}

// The shards of each profile: about `targetSeconds` of tests each, at most
// `maxShards`, longest check first to the shard with the least time.
export function shard(ids, seconds, fileWeights = weights()) {
  const byProfile = new Map()
  for (const id of new Set(ids)) {
    const profile = runsInOf(id)?.profile
    if (!profile) continue
    byProfile.set(profile, [
      ...(byProfile.get(profile) ?? []),
      { id, seconds: estimate(id, seconds, fileWeights) },
    ])
  }
  const out = {}
  for (const [profile, checks] of [...byProfile].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const total = checks.reduce((sum, check) => sum + check.seconds, 0)
    const count = Math.min(
      profiles[profile].maxShards,
      // About 300 s of tests for each shard.
      Math.max(1, Math.ceil(total / 300)),
      checks.length,
    )
    const shards = Array.from({ length: count }, () => ({
      ids: [],
      seconds: 0,
    }))
    checks.sort((a, b) => b.seconds - a.seconds || (a.id < b.id ? -1 : 1))
    for (const check of checks) {
      const least = shards.reduce((low, item) =>
        item.seconds < low.seconds ? item : low,
      )
      least.ids.push(check.id)
      least.seconds += check.seconds
    }
    for (const item of shards) {
      item.ids.sort()
      item.seconds = Math.round(item.seconds)
    }
    out[profile] = shards
  }
  return out
}

// The runner minutes of the shards: setup and tests of each shard, and the
// Storybook build when a story runs.
export function shardMinutes(shards) {
  let minutes = 0
  for (const [profile, list] of Object.entries(shards))
    for (const item of list)
      minutes += profiles[profile].setupMinutes + item.seconds / 60
  if (shards.storybook) minutes += storybookBuildMinutes
  return Math.round(minutes * 10) / 10
}
