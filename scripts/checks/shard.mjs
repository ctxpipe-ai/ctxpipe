import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

// Packs check ids into the shards of the CI jobs that run them (the profile
// jobs of the merge gate, scripts/checks/README.md). The selector outputs
// only ids; this public script decides how they run.
// Usage: shard.mjs [--trace <trace.json.gz>] <ids-file>
// It prints one JSON object: for each profile with ids, its shards, each with
// its ids and its estimated test seconds.

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

// The test time that one shard should get.
const targetSeconds = 300

// The profile of a check id, or undefined for a check that no profile job
// runs (an eval, the latency check: they have their own workflows).
export function profileOf(id) {
  const [family, lane] = id.split(":")
  if (["lint", "policy", "typecheck"].includes(family)) return "project"
  if (family === "storybook") return "storybook"
  if (family !== "vitest") return undefined
  return {
    ui: "node",
    cli: "node",
    "aws-cdk": "node",
    backend: "database",
    contracts: "database",
    upgrade: "upgrade",
    codesearch: "codesearch",
    "codesearch-bun": "codesearch",
    vercel: "vercel",
  }[lane]
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
    const profile = profileOf(id)
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
      Math.max(1, Math.ceil(total / targetSeconds)),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    const args = process.argv.slice(2)
    const at = args.indexOf("--trace")
    const trace = at === -1 ? undefined : readTrace(args[at + 1])
    if (at !== -1) args.splice(at, 2)
    if (args.length !== 1)
      throw new Error("Usage: shard.mjs [--trace <trace.json.gz>] <ids-file>")
    const ids = readFileSync(args[0], "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    process.stdout.write(`${JSON.stringify(shard(ids, traceSeconds(trace)))}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
