import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { schemaErrors } from "./schema.mjs"
import {
  lintSteps,
  readTrace,
  runsInOf,
  shard,
  traceSeconds,
} from "./shard.mjs"

// The plan of a gated run (scripts/checks/README.md, Merge gate): which
// checks run, in which ci.yaml job and shard, and which stored pass each
// other selected check reuses. It runs in a job without dependencies, so it
// imports no package.

const readJson = (path) =>
  path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined

const readText = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().slice(0, 200) : ""

// True when the gated run accepts a stored pass of this class for a check of
// this lane. The vercel job sets lane variables that the manifest job does
// not set (GITHUB_TOKEN and VERCEL_TOKEN), so the key from the toolchain
// record does not describe an agent run of its checks: an agent hit is not
// accepted there. A `pr` pass comes from a CI job of this PR, so the job had
// those variables.
export function accepted(source, lane, config) {
  if (source === "ci") return true
  if (source === "agent")
    return config.acceptAgentResults === true && lane !== "vercel"
  if (source === "pr") return config.acceptPrResults === true
  return false
}

// The selection with each check of the jobs of a job-scoped ci.yaml change
// (decideMode) selected and without a hit: no cache key holds ci.yaml. A
// Storybook job runs on the Storybook build.
export function withJobChecks(selection, jobs) {
  const reached = new Set(
    jobs.flatMap((job) =>
      job === "storybook-build"
        ? ["storybook-golden", "storybook-plays"]
        : [job],
    ),
  )
  const runs = (check) => reached.has(runsInOf(check.id)?.job)
  const reason = { kind: "jobs", jobs }
  const added = selection.omitted
    .filter(runs)
    .map((check) => ({ ...check, reason }))
  return {
    ...selection,
    selected: [...selection.selected, ...added],
    omitted: selection.omitted.filter((check) => !runs(check)),
    counts: {
      ...selection.counts,
      selected: selection.counts.selected + added.length,
    },
    cache: selection.cache && {
      ...selection.cache,
      hits: (selection.cache.hits ?? []).filter((hit) => !runs(hit)),
      // A check of such a job runs, so its key is a miss of this run.
      misses: [
        ...(selection.cache.misses ?? []),
        ...(selection.cache.hits ?? []).filter(runs).map((hit) => ({
          id: hit.id,
          key: hit.key,
          mode: "jobs",
        })),
      ],
    },
  }
}

// The selection of the gate: the selected and omitted checks of the LLM job
// (the deterministic layers, then the LLM stage), with the cache lookup of
// the select job. A check that only the LLM job selected (the LLM added it,
// or the package intent step widened to it) has no lookup, so it runs.
// Without a valid LLM record, the selection of the select job stays, with a
// note that says why.
export function combine(select, llm, llmCause) {
  if (!llm || schemaErrors(llm, "selection.v1", 1).length)
    return {
      ...select,
      notes: [
        ...select.notes,
        `llm job: ${llmCause || "no valid selection record"}; the deterministic selection stays`,
      ],
    }
  const chosen = new Set(llm.selected.map((check) => check.id))
  const keep = (list) => (list ?? []).filter((item) => chosen.has(item.id))
  return {
    ...llm,
    timingsMs: select.timingsMs,
    cache: select.cache && {
      ...select.cache,
      hits: keep(select.cache.hits),
      misses: keep(select.cache.misses),
      unkeyed: keep(select.cache.unkeyed),
    },
  }
}

// The PR store: the passes of the earlier runs of this PR (the `pr` class).
// The merge gate job writes it to the GitHub Actions cache of the PR, and the
// plan job reads it. Only the runs of this PR can write that cache scope.
export function readStore(value) {
  const empty = { schemaVersion: 1, entries: [], quarantined: [] }
  if (value?.schemaVersion !== 1) return empty
  const hex = (text) => typeof text === "string" && /^[0-9a-f]{64}$/.test(text)
  return {
    schemaVersion: 1,
    entries: (Array.isArray(value.entries) ? value.entries : []).filter(
      (entry) =>
        typeof entry?.id === "string" &&
        hex(entry.key) &&
        /^\d+$/.test(String(entry.run)) &&
        typeof entry.createdAt === "string" &&
        !Number.isNaN(Date.parse(entry.createdAt)),
    ),
    quarantined: (Array.isArray(value.quarantined)
      ? value.quarantined
      : []
    ).filter(hex),
  }
}

// The selection with a `pr` hit for each miss whose id and key have a pass in
// the PR store. A key that the PR store quarantined has no hit of any class
// in this PR: the check runs.
export function withStoreHits(selection, store) {
  if (!selection.cache) return selection
  const blocked = new Set(store.quarantined)
  const refused = (selection.cache.hits ?? []).filter((hit) =>
    blocked.has(hit.key),
  )
  const passes = new Map(
    store.entries
      .filter((entry) => !blocked.has(entry.key))
      .map((entry) => [`${entry.id}\0${entry.key}`, entry]),
  )
  const hits = (selection.cache.hits ?? []).filter(
    (hit) => !blocked.has(hit.key),
  )
  const misses = refused.map((hit) => ({
    id: hit.id,
    key: hit.key,
    mode: "quarantined",
  }))
  for (const miss of selection.cache.misses ?? []) {
    const entry = passes.get(`${miss.id}\0${miss.key}`)
    if (entry)
      hits.push({
        id: miss.id,
        key: miss.key,
        source: "pr",
        provenance: {
          hostKind: "ci",
          createdAt: entry.createdAt,
          run: String(entry.run),
        },
      })
    else misses.push(miss)
  }
  return {
    ...selection,
    cache: {
      ...selection.cache,
      hits,
      misses,
      notes: [
        ...(selection.cache.notes ?? []),
        ...refused.map(
          (hit) =>
            `${hit.id}: a gated run of this PR failed its key after a stored pass, so the ${hit.source} hit is not accepted`,
        ),
      ],
    },
  }
}

// Where a check runs in a gated run. The Lint and format job runs each lint
// and policy check as a step, on each run. Every Storybook check runs in the
// Storybook plays shards. A check that ci.yaml does not run is `external`:
// another workflow runs it, and its own status reports the result.
const external = {
  deploy: "PR Deploy (pr-deploy.yaml, started by the merge gate)",
  eval: "MCP evals (mcp-evals.yaml)",
  "policy:terraform-plan": "Terraform plan (terraform-plan-pr.yaml)",
}
export function placeOf(id) {
  const [family, lane] = id.split(":")
  if (Object.values(lintSteps).some((prefix) => id.startsWith(prefix)))
    return { job: "lint" }
  const workflow = external[`${family}:${lane}`] ?? external[family]
  if (workflow) return { workflow }
  if (family === "storybook") return { job: "storybook-plays" }
  const job = runsInOf(id)?.job
  return job ? { job } : { workflow: "no job of PR CI runs it" }
}

// The image builds of the Production build job. A test keeps these entries
// equal to the matrix of ci.yaml.
const imageOptions = {
  "chat-sandbox": { context: "scripts/chat-sandbox", platforms: "linux/arm64" },
}

// The jobs that a gated run starts, as the outputs of the plan job. Each
// job has the ids that it runs and the ids that it runs once more when they
// fail (`rerun`: a stored pass has the key of the check, so a failure is a
// contradiction). A matrix job has a list of entries. A job without an output
// does not start.
export function jobOutputs(ran, seconds, rerun = new Set()) {
  const part = (ids) => ({
    ids,
    rerun: ids.filter((id) => rerun.has(id)),
  })
  const byJob = new Map()
  for (const id of ran) {
    const { job } = placeOf(id)
    if (!job || job === "lint") continue
    byJob.set(job, [...(byJob.get(job) ?? []), id])
  }
  const outputs = {}
  for (const [job, ids] of byJob) {
    ids.sort()
    if (job === "test-shards" || job === "storybook-plays") {
      const shards = Object.values(shard(ids, seconds)).flat()
      outputs[job] = JSON.stringify(
        shards.map((item, index) => ({
          lane: "selected",
          shard: index + 1,
          count: shards.length,
          plan: part(item.ids),
        })),
      )
      if (job === "storybook-plays") outputs["storybook-build"] = "true"
    } else if (job === "production-builds")
      outputs[job] = JSON.stringify(
        ids.map((id) => {
          const [, lane, ...file] = id.split(":")
          const name = lane.replace(/^image-/, "")
          return { name, dockerfile: file.join(":"), ...imageOptions[name] }
        }),
      )
    else outputs[job] = JSON.stringify(part(ids))
  }
  return outputs
}

// Why the selector gave no selection for this run, or undefined when it did.
// <inputs> holds the artifacts of the manifest and select jobs.
export function fallbackOf({ mode, selection, inputs, needs }) {
  const select = needs["merge-gate-select"]?.result
  if (!mode)
    return `manifest job ${needs["merge-gate-manifest"]?.result ?? "did not run"}`
  if (mode.mode !== "select") return mode.reason
  if (select !== "success" || !selection) {
    // The select job writes why it failed: the download, the hash, the exit
    // code of the selector, or a timeout.
    const cause = readText(join(inputs, "select-cause.txt"))
    return `selector unavailable: ${cause || `select job ${select ?? "did not run"}`}`
  }
  const errors = schemaErrors(selection, "selection.v1", 1)
  if (errors.length)
    return `selector unavailable: the record does not match the schema (${errors[0]})`
  return undefined
}

// The plan of this PR run. `mode` is `gate` only when merge-gate.json is in
// gate mode and the selector gave a selection; else the run is full.
// `deploy` is true when the merge gate starts PR Deploy: in gate mode,
// PR Deploy runs on a push only when the merge gate starts it.
export function plan({ config, inputs, needs, store, fork }) {
  const mode = readJson(join(inputs, "mode.json"))
  const select = readJson(join(inputs, "selection.json"))
  const fallback = fallbackOf({ mode, selection: select, inputs, needs })
  const gate = config.mode === "gate"
  if (fallback)
    return {
      schemaVersion: 1,
      config: config.mode,
      mode: "full",
      reason: fallback,
      outputs: {},
      deploy: gate && !fork,
    }
  let selection = combine(
    select,
    readJson(join(inputs, "llm-selection.json")),
    readText(join(inputs, "llm-cause.txt")),
  )
  if (mode.jobs?.length) selection = withJobChecks(selection, mode.jobs)
  selection = withStoreHits(selection, store)
  const lanes = new Map(selection.selected.map((check) => [check.id, check]))
  const hits = new Map()
  for (const hit of selection.cache?.hits ?? [])
    if (
      lanes.has(hit.id) &&
      !hits.has(hit.id) &&
      accepted(hit.source, lanes.get(hit.id).lane, config)
    )
      hits.set(hit.id, hit)
  const ran = selection.selected
    .filter((check) => !hits.has(check.id))
    .map((check) => check.id)
  // A check that runs although a pass is stored for its key: a hit that is
  // not accepted, or a check of a job-scoped ci.yaml change.
  const stored = new Set([
    ...(selection.cache?.hits ?? []).map((hit) => hit.id),
    ...(selection.cache?.misses ?? [])
      .filter((miss) => ["jobs", "quarantined"].includes(miss.mode))
      .map((miss) => miss.id),
  ])
  const rerun = new Set(ran.filter((id) => stored.has(id)))
  const trace = existsSync(join(inputs, "trace.json.gz"))
    ? readTrace(join(inputs, "trace.json.gz"))
    : undefined
  const outputs = gate ? jobOutputs(ran, traceSeconds(trace), rerun) : {}
  return {
    schemaVersion: 1,
    config: config.mode,
    mode: gate ? "gate" : "full",
    reason: gate ? "gate" : config.mode,
    selection,
    hits: [...hits.values()],
    ran,
    rerun: [...rerun].sort(),
    outputs,
    deploy: gate && !fork && ran.some((id) => id.startsWith("deploy:")),
  }
}
