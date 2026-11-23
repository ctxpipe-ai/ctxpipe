import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { schemaErrors } from "./schema.mjs"
import { profiles, readTrace, runsInOf, shard, traceSeconds } from "./shard.mjs"

// The plan of a gated run (scripts/checks/README.md, Merge gate): which
// checks run, in which ci.yaml job and shard, and which stored pass each
// other selected check reuses. It runs in a job without dependencies, so it
// imports no package.

// A file that is absent or does not parse gives undefined.
const readJson = (path) => {
  try {
    return path && existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined
  } catch {
    return undefined
  }
}

const readText = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().slice(0, 200) : ""

// True when the gated run accepts a stored pass of this class. A `pr` pass
// comes from a CI job of this PR. A `carry` hit is a pass of the PR head
// whose own class (`headSource`) this function accepts (withCarry).
export function accepted(source, config) {
  if (source === "ci" || source === "carry") return true
  if (source === "agent") return config.acceptAgentResults === true
  if (source === "pr") return config.acceptPrResults === true
  return false
}

// The selection with each check that `runs` gives selected, because the
// gate inputs changed (`reason.kind` is `jobs`, `gate`, `definition` or
// `runner`). Unless
// `keepHits`, each hit of such a check, also a `pr` hit, becomes a miss of
// this run with that mode: an earlier run of the PR can have run it with
// other gate inputs under the same key.
function withChecks(selection, runs, reason, { keepHits = false } = {}) {
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
    cache: keepHits
      ? selection.cache
      : selection.cache && {
          ...selection.cache,
          hits: (selection.cache.hits ?? []).filter((hit) => !runs(hit)),
          // A stored pass for the key of a check that runs: a failure
          // contradicts it (`rerun`). A `carry` hit is a pass of another
          // key, so its check gets a plain miss.
          misses: [
            ...(selection.cache.misses ?? []),
            ...(selection.cache.hits ?? []).filter(runs).map((hit) => ({
              id: hit.id,
              key: hit.key,
              ...(hit.source !== "carry" && { mode: reason.kind }),
            })),
          ],
        },
  }
}

// The selection with each check of the jobs of a job-scoped ci.yaml change
// (decideMode): no cache key holds ci.yaml. A Storybook job runs on the
// Storybook build.
export function withJobChecks(selection, jobs) {
  const reached = new Set(
    jobs.flatMap((job) =>
      job === "storybook-build"
        ? ["storybook-required", "storybook-plays", "storybook-visual"]
        : [job],
    ),
  )
  return withChecks(
    selection,
    (check) => reached.has(runsInOf(check.id)?.job),
    { kind: "jobs", jobs },
  )
}

// The selection with each test of the CI scripts (`policy:tests-*`) of a
// change to a gate input that the base revision decides (`reason.kind`
// `gate`) or to a runner file (`runner`, decideMode). These tests cover the
// gate code, the pin and the runner, so the LLM stage must not drop them.
// Their keys hold scripts/** and .github/**, so a hit is a pass of this
// code.
function withScriptTests(selection, reason) {
  return withChecks(
    selection,
    (check) => check.id.startsWith("policy:tests-"),
    reason,
    { keepHits: true },
  )
}

// The jobs of ci.yaml that run checks through the runner files in a gated
// run (selected.mjs, or run.mjs directly). A test keeps this set equal to the
// jobs of a pull_request run whose steps call one of them.
export const runnerJobs = new Set([
  "lint",
  "typecheck",
  "test-shards",
  "package-tests",
  "packages",
  "storybook-plays",
  "storybook-visual",
  "upgrade-from-previous-release",
])

// The selection split into the accepted hit of each selected check and the
// ids of the checks that run.
function hitsAndRuns(selection, config) {
  const selected = new Set(selection.selected.map((check) => check.id))
  const hits = new Map()
  for (const hit of selection.cache?.hits ?? [])
    if (selected.has(hit.id) && !hits.has(hit.id) && accepted(hit.source, config))
      hits.set(hit.id, hit)
  const ran = selection.selected
    .filter((check) => !hits.has(check.id))
    .map((check) => check.id)
  return { hits, ran }
}

// The floor of a change to a runner file (decideMode), which the LLM stage
// cannot drop. First every test of the CI scripts (withScriptTests). Then,
// after the hits, a canary in each runner job that runs no check: the check
// of that job with the fewest seconds in the trace (a check without a trace
// time comes last). A canary gets no hit, so CI runs it with the runner of
// the PR. `stored` holds the hits of the deterministic selection with the
// PR store: the LLM stage drops the cache entry of each check that it
// drops, so a canary with a stored pass gets its miss with mode `runner`
// from there, and a failure is a contradiction. Returns the selection and
// the canary ids.
function withRunnerFloor(selection, { inputs, seconds, stored, config }) {
  let floored = withScriptTests(selection, { kind: "runner", inputs })
  const busy = new Set(
    hitsAndRuns(floored, config).ran.map((id) => placeOf(id).job),
  )
  const cost = (id) => seconds.get(id) ?? Number.POSITIVE_INFINITY
  const canaries = []
  for (const job of runnerJobs) {
    if (busy.has(job)) continue
    const [canary] = [...floored.selected, ...floored.omitted]
      .map((check) => check.id)
      .filter((id) => placeOf(id).job === job)
      .sort((a, b) => cost(a) - cost(b) || (a < b ? -1 : 1))
    if (!canary) continue
    canaries.push(canary)
    floored = withChecks(floored, (check) => check.id === canary, {
      kind: "runner",
      inputs,
      job,
    })
    const known = [
      ...(floored.cache?.hits ?? []),
      ...(floored.cache?.misses ?? []),
    ].some((item) => item.id === canary)
    const hit = stored.find((item) => item.id === canary)
    if (floored.cache && hit && !known)
      floored = {
        ...floored,
        cache: {
          ...floored.cache,
          misses: [
            ...(floored.cache.misses ?? []),
            { id: canary, key: hit.key, mode: "runner" },
          ],
        },
      }
  }
  return { selection: floored, canaries }
}

// The checks whose definition the PR changed. It compares two listings of
// the merge revision. The code of the PR made the manifest that the selector
// keyed. The code of the base revision made the other listing, before any PR
// code ran. It gives these lists of check ids:
// - `dropped`: the base lists the check, and the PR does not.
// - `twice`: a listing gives the id more than once. Then the plan cannot know
//   which entry the selector keyed.
// - `owned`: the `ownInputs` of the check differ, or only the PR gives the
//   check with `ownInputs`. Own inputs keep a change from selecting other
//   checks, so they can drop checks from the selection.
// - `changed`: a check with a key that only the PR lists, or whose entry
//   differs other than by more inputs or another intent. More inputs only
//   make a key wider, so no pass of the old definition matches it. An eval
//   or a stochastic check has no key, so it reuses no pass.
export function definitionChanges(base, manifest) {
  const keyed = (check) => !check.stochastic && check.family !== "eval"
  // The entry with its object keys in order, so that two entries with the
  // same fields compare equal.
  const rest = ({ intent: _intent, inputs: _inputs, ownInputs: _own, ...item }) =>
    JSON.stringify(item, (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : value,
    )
  const twice = [base, manifest].flatMap(({ checks }) =>
    checks
      .map((check) => check.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  )
  const covers = (some = [], all = []) => some.every((item) => all.includes(item))
  const same = (a = [], b = []) => covers(a, b) && covers(b, a)
  const pr = new Map(manifest.checks.map((check) => [check.id, check]))
  const listed = new Map(base.checks.map((check) => [check.id, check]))
  const dropped = []
  const owned = []
  const changed = []
  for (const check of base.checks) {
    const other = pr.get(check.id)
    if (!other) dropped.push(check.id)
    else if (!same(check.ownInputs, other.ownInputs)) owned.push(check.id)
    else if (
      keyed(check) &&
      (rest(check) !== rest(other) || !covers(check.inputs, other.inputs))
    )
      changed.push(check.id)
  }
  for (const [id, check] of pr)
    if (listed.has(id)) continue
    else if (check.ownInputs?.length) owned.push(id)
    else if (keyed(check)) changed.push(id)
  return {
    dropped: dropped.sort(),
    twice: [...new Set(twice)].sort(),
    owned: owned.sort(),
    changed: changed.sort(),
  }
}

// The selection with each check whose definition the PR changed selected,
// without a hit of any class: its key comes from the definition of the PR.
function withDefinitionChecks(selection, changed, inputs) {
  const ids = new Set(changed)
  return withChecks(selection, (check) => ids.has(check.id), {
    kind: "definition",
    inputs,
  })
}

// The selection of the gate: the selected and omitted checks of the LLM job
// (the deterministic layers, then the LLM stage), with the cache lookup of
// the select job. A check that only the LLM job selected (the LLM added it,
// or the package intent step widened to it) has no lookup, so it runs.
// A failed LLM job, an invalid LLM record or a provider fallback (the LLM
// stage did not decide) keeps the selection of the select job, with a note
// that says why. That selection is a superset of what the LLM stage keeps,
// so the run stays gated. Only a failed select job or plan job gives a full
// run.
export function combine(select, llm, llmCause) {
  const cause = !llm
    ? llmCause || "no valid selection record"
    : schemaErrors(llm, "selection.v1", 1).length
      ? "no valid selection record"
      : llm.llm?.fallback
        ? `provider fallback (${llm.llm.fallback})`
        : undefined
  if (cause)
    return {
      ...select,
      notes: [
        ...select.notes,
        `llm job: ${cause}; the deterministic selection stays`,
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

// A miss whose key has a stored pass that this run does not accept: a check
// of a job-scoped ci.yaml change (withJobChecks), a check whose definition
// the PR changed (withDefinitionChecks), a canary of a runner change
// (withRunnerFloor) or a quarantined key (withStoreHits).
export const storedMiss = (miss) =>
  ["jobs", "definition", "runner", "quarantined"].includes(miss.mode)

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

// Main-delta carry (scripts/checks/README.md, Main-delta carry): a pass of
// the PR head counts at the merge revision when the changes that main
// brought since the merge base do not select its check. `lookup` is the
// cache lookup of the select job on the tree of the PR head (the second
// parent of the merge revision), with the same rules and toolchain record;
// `lookupCause` says why it is missing. `delta` is the selection of the LLM
// job on main's delta: the merge revision against the PR head, with the LLM
// stage. A miss of the merge revision becomes a `carry` hit when:
// - the head key of its check has a pass of a class that the gate accepts,
//   also in the PR store, and neither key is quarantined;
// - main's delta omits the check.
// Without a valid delta whose model steps answered, no pass carries, and the
// checks run. Returns the selection and the carry record of the plan (the
// head, or why no pass carries), or no record when the select job made no
// lookup (main did not move, or the merge revision has no miss).
export function withCarry(
  selection,
  { lookup, lookupCause, delta, deltaCause, store, config },
) {
  if (!lookup && !lookupCause) return { selection }
  const cause = !lookup
    ? lookupCause
    : schemaErrors(lookup, "selection.v1", 1).length || !lookup.cache
      ? "no valid lookup of the PR head"
      : [selection, lookup].some(
            (record) => !Array.isArray(record.cache?.quarantined),
          )
        ? "a cache lookup names no quarantined key"
        : !delta
          ? deltaCause || "no selection of main's delta"
          : schemaErrors(delta, "selection.v1", 1).length
            ? "no valid selection of main's delta"
            : !delta.llm
              ? "the LLM stage did not run on main's delta"
              : delta.llm.fallback
                ? `LLM fallback on main's delta (${delta.llm.fallback})`
                : delta.packageIntent?.fallback &&
                    delta.packageIntent.groups > 0
                  ? `package intent fallback on main's delta (${delta.packageIntent.fallback})`
                  : undefined
  if (cause) return { selection, carry: { cause } }
  const blocked = new Set([
    ...store.quarantined,
    ...selection.cache.quarantined,
    ...lookup.cache.quarantined,
  ])
  const passes = new Map(
    withStoreHits(lookup, store)
      .cache.hits.filter((hit) => accepted(hit.source, config))
      .map((hit) => [hit.id, hit]),
  )
  const reached = new Set(delta.selected.map((check) => check.id))
  const omitted = new Set(
    delta.omitted.map((check) => check.id).filter((id) => !reached.has(id)),
  )
  const hits = [...(selection.cache.hits ?? [])]
  const misses = []
  for (const miss of selection.cache.misses ?? []) {
    const pass = passes.get(miss.id)
    if (
      pass &&
      omitted.has(miss.id) &&
      !blocked.has(miss.key) &&
      !blocked.has(pass.key)
    )
      hits.push({
        id: miss.id,
        key: miss.key,
        source: "carry",
        headSource: pass.source,
        headKey: pass.key,
        provenance: pass.provenance,
      })
    else misses.push(miss)
  }
  return {
    selection: { ...selection, cache: { ...selection.cache, hits, misses } },
    carry: { head: delta.base },
  }
}

// Where a check runs in a gated run. Every Storybook play runs in the
// Storybook plays shards, and each screenshot in the screenshots shards
// (runsIn). A check that ci.yaml does not run is `external`:
// another workflow runs it, and its own status reports the result.
const external = {
  eval: "MCP evals (mcp-evals.yaml, starts with the label mcp-evals)",
}
export function placeOf(id) {
  const [family, lane] = id.split(":")
  const workflow = external[family]
  if (workflow) return { workflow }
  if (family === "storybook" && lane !== "visual")
    return { job: "storybook-plays" }
  const job = runsInOf(id)?.job
  return job ? { job } : { workflow: "no job of PR CI runs it" }
}

// The image builds of the Production build job. A test keeps these entries
// equal to the matrix of ci.yaml.
const imageOptions = {
  "chat-sandbox": { context: "scripts/chat-sandbox" },
  "cost-telemetry": { context: "ops/observability/cost-telemetry" },
}

// The matrix jobs whose checks shard.mjs packs into shards.
const shardedJobs = ["test-shards", "storybook-plays", "storybook-visual"]

// The jobs that a gated run starts, with the checks of each (`jobs` in
// plan.json). Each job has the ids that it runs and the ids that it runs once
// more when they fail (`rerun`: a stored pass has the key of the check, so a
// failure is a contradiction). A matrix job has a list of entries.
export function jobPlans(ran, seconds, rerun = new Set()) {
  const part = (ids) => ({
    ids,
    rerun: ids.filter((id) => rerun.has(id)),
  })
  const byJob = new Map()
  for (const id of ran) {
    const { job } = placeOf(id)
    if (!job) continue
    byJob.set(job, [...(byJob.get(job) ?? []), id])
  }
  const jobs = {}
  for (const [job, ids] of byJob) {
    ids.sort()
    if (shardedJobs.includes(job)) {
      const shards = Object.values(shard(ids, seconds)).flat()
      jobs[job] = shards.map((item, index) => ({
        lane: "selected",
        shard: index + 1,
        count: shards.length,
        plan: part(item.ids),
      }))
    } else if (job === "production-builds")
      jobs[job] = ids.map((id) => {
        const [, lane, ...file] = id.split(":")
        const name = lane.replace(/^image-/, "")
        return { name, dockerfile: file.join(":"), ...imageOptions[name] }
      })
    else jobs[job] = part(ids)
  }
  return jobs
}

// The outputs of the plan job: only what GitHub needs to start each job. A
// job without an output does not start. A matrix job gets its entries
// without their check ids; another job gets the count of its checks. Each
// job reads its check ids from plan.json (selected.mjs). The `needs` context
// of the Merge gate job holds these outputs in one environment value, and
// Linux limits that value to 128 KiB, so they must not grow with the count
// of checks.
function jobOutputs(jobs) {
  const outputs = {}
  for (const [job, value] of Object.entries(jobs))
    outputs[job] = Array.isArray(value)
      ? JSON.stringify(value.map(({ plan: _plan, ...entry }) => entry))
      : String(value.ids.length)
  if (jobs["storybook-plays"] || jobs["storybook-visual"])
    outputs["storybook-build"] = "true"
  return outputs
}

// The plan of a nightly run on main (scripts/checks/README.md, Traces), from
// the record of `factory nightly plan`: its `run` ids in the jobs of ci.yaml.
// A full factory plan (by hand, without a previous trace, or each 7 days)
// gives a full run. An incremental one gives a gated run with three
// differences from a PR run:
// - The project checks (typecheck, lint, policy) run in the Project check
//   times job, which records their time for the trace.
// - The Storybook plays job renders each story whose play check runs, or whose
//   screenshot check needs a new trace record: one rendered story records the
//   lines of both ids (storybook-plays.mjs, STORYBOOK_IDS). A screenshot
//   check of the run (in the trace or in the audit sample) also runs in the
//   screenshots job.
// - No check is in `rerun`: each job of the nightly run runs its failed checks
//   once more for the Results writer.
// `seconds` are the check times of the previous trace (traceSeconds).
export function nightlyPlan(factory, seconds) {
  if (factory?.schemaVersion !== 1 || !Array.isArray(factory.run))
    throw new Error("not a factory nightly plan (schemaVersion 1)")
  if (factory.full)
    return {
      schemaVersion: 1,
      config: "nightly",
      mode: "full",
      reason: `nightly: ${factory.full}`,
      jobs: {},
      outputs: {},
    }
  const family = (id) => id.split(":")[0]
  const project = (id) => ["typecheck", "lint", "policy"].includes(family(id))
  const traced = new Set(factory.trace.map((planned) => planned.id))
  const visual = (id) => id.startsWith("storybook:visual:")
  const playsOf = (id) =>
    visual(id) ? `storybook:plays:${id.slice("storybook:visual:".length)}` : id
  // One id for each story (`<file>#<story>`): a render records every check id
  // of its story in the trace of its shard, and `trace.mjs merge` rejects an
  // id in two traces. The id of the play or required check wins.
  const byStory = new Map()
  for (const id of factory.run)
    if (family(id) === "storybook" && (!visual(id) || traced.has(id))) {
      const story = id.split(":").slice(2).join(":")
      if (!visual(id) || !byStory.has(story)) byStory.set(story, playsOf(id))
    }
  const rendered = [...byStory.values()].sort()
  const rest = factory.run.filter(
    (id) => !project(id) && (family(id) !== "storybook" || visual(id)),
  )
  const jobs = jobPlans(rest, seconds)
  if (rendered.length) {
    const shards = Object.values(shard(rendered, seconds)).flat()
    jobs["storybook-plays"] = shards.map((item, index) => ({
      lane: "selected",
      shard: index + 1,
      count: shards.length,
      plan: { ids: item.ids, rerun: [] },
    }))
  }
  const projects = factory.run.filter(project).sort()
  if (projects.length) jobs["project-checks"] = { ids: projects, rerun: [] }
  return {
    schemaVersion: 1,
    config: "nightly",
    mode: "gate",
    reason: "nightly",
    ran: factory.run,
    rerun: [],
    jobs,
    outputs: jobOutputs(jobs),
  }
}

// The shards of each sharded job of a gated run, for the merge gate report:
// the shard count, the shard count of a full run, and the estimated minutes
// of tests in all shards and in the longest shard.
function packing(ran, seconds) {
  const out = {}
  for (const job of shardedJobs) {
    const ids = ran.filter((id) => placeOf(id).job === job)
    for (const [profile, list] of Object.entries(shard(ids, seconds))) {
      const minutes = (value) => Math.round((value / 60) * 10) / 10
      out[job] = {
        shards: list.length,
        fullShards: profiles[profile].maxShards,
        minutes: minutes(list.reduce((sum, item) => sum + item.seconds, 0)),
        longestMinutes: minutes(Math.max(...list.map((item) => item.seconds))),
      }
    }
  }
  return out
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
export function plan({ config, inputs, needs, store }) {
  const mode = readJson(join(inputs, "mode.json"))
  const select = readJson(join(inputs, "selection.json"))
  const fallback = fallbackOf({ mode, selection: select, inputs, needs })
  const gate = config.mode === "gate"
  const full = (reason) => ({
    schemaVersion: 1,
    config: config.mode,
    mode: "full",
    reason,
    jobs: {},
    outputs: {},
  })
  if (fallback) return full(fallback)
  // A change to a definition of checks (decideMode): the code of the base
  // revision listed the same tree, and the plan compares that listing with
  // the manifest of the PR. The LLM stage does not decide such a run.
  const definitions = mode.definitions ?? []
  let changes
  if (definitions.length) {
    const fullFor = (reason) =>
      full(`definitions of checks changed, and ${reason}`)
    const base = readJson(join(inputs, "base-manifest.json"))
    const manifest = readJson(join(inputs, "manifest.json"))
    if (
      [base, manifest].some(
        (listing) => !listing || schemaErrors(listing, "manifest.v1", 1).length,
      )
    )
      return fullFor(
        "no valid listing of the base revision or of the PR is available",
      )
    changes = definitionChanges(base, manifest)
    const { dropped, twice, owned } = changes
    if (twice.length)
      return fullFor(`a listing gives a check id twice: ${twice.slice(0, 3).join(", ")}`)
    if (owned.length)
      return fullFor(
        `the own inputs of a check changed: ${owned.slice(0, 3).join(", ")}${owned.length > 3 ? " and more" : ""}`,
      )
    if (dropped.length)
      return fullFor(
        `the listing of this PR drops ${dropped.length} ${dropped.length === 1 ? "check" : "checks"} that the base revision lists for the same tree: ${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? " and more" : ""}`,
      )
  }
  let selection = combine(
    select,
    definitions.length ? undefined : readJson(join(inputs, "llm-selection.json")),
    definitions.length
      ? "a definition of checks changed, so the LLM stage does not decide"
      : readText(join(inputs, "llm-cause.txt")),
  )
  // The PR store first: a check of a job-scoped ci.yaml change then loses
  // its `pr` hit too. Then the carry: a later rule that runs a check takes
  // its carry hit back too.
  selection = withStoreHits(selection, store)
  let carry
  ;({ selection, carry } = withCarry(selection, {
    lookup: readJson(join(inputs, "head-lookup.json")),
    lookupCause: readText(join(inputs, "head-lookup-cause.txt")),
    delta: readJson(join(inputs, "main-delta.json")),
    deltaCause: readText(join(inputs, "main-delta-cause.txt")),
    store,
    config,
  }))
  if (mode.jobs?.length) selection = withJobChecks(selection, mode.jobs)
  if (changes) {
    selection = withDefinitionChecks(selection, changes.changed, definitions)
    // The selector lists a stochastic check in no list, so a check that the
    // PR made stochastic is in no selection: the plan cannot run it.
    const selected = new Set(selection.selected.map((check) => check.id))
    const lost = changes.changed.filter((id) => !selected.has(id))
    if (lost.length)
      return full(
        `definitions of checks changed, and ${lost.length} ${lost.length === 1 ? "check" : "checks"} whose definition changed ${lost.length === 1 ? "is" : "are"} in no selection: ${lost.slice(0, 3).join(", ")}`,
      )
  }
  const gateInputs = mode.gateInputs ?? []
  if (gateInputs.length)
    selection = withScriptTests(selection, { kind: "gate", inputs: gateInputs })
  const trace = existsSync(join(inputs, "trace.json.gz"))
    ? readTrace(join(inputs, "trace.json.gz"))
    : undefined
  const seconds = traceSeconds(trace)
  const runner = mode.runner ?? []
  let canaries = []
  if (runner.length)
    ({ selection, canaries } = withRunnerFloor(selection, {
      inputs: runner,
      seconds,
      stored: withStoreHits(select, store).cache?.hits ?? [],
      config,
    }))
  const { hits, ran } = hitsAndRuns(selection, config)
  // A check that runs although a pass is stored for its key: a hit that is
  // not accepted, a check of a job-scoped ci.yaml change, a canary of a
  // runner change, or a quarantined key.
  const stored = new Set([
    ...(selection.cache?.hits ?? []).map((hit) => hit.id),
    ...(selection.cache?.misses ?? [])
      .filter(storedMiss)
      .map((miss) => miss.id),
  ])
  const rerun = new Set(ran.filter((id) => stored.has(id)))
  const jobs = gate ? jobPlans(ran, seconds, rerun) : {}
  return {
    schemaVersion: 1,
    config: config.mode,
    mode: gate ? "gate" : "full",
    reason: `${gate ? "gate" : config.mode}${
      gateInputs.length
        ? `; gate inputs changed (${gateInputs.join(", ")}): the gate code and the pin of the base revision decide, and every test of the CI scripts runs`
        : ""
    }${
      runner.length
        ? `; runner changed (${runner.join(", ")}): every test of the CI scripts runs, and each job that runs checks through the runner runs a check with no stored pass`
        : ""
    }${
      changes
        ? `; definitions of checks changed (${definitions.join(", ")}): the base revision listed the same tree, and ${changes.changed.length} checks whose definition changed run without a stored pass`
        : ""
    }`,
    gateInputs,
    // The carried hits that the later rules kept.
    ...(carry && {
      carry: {
        ...carry,
        ids: [...hits.values()]
          .filter((hit) => hit.source === "carry")
          .map((hit) => hit.id),
      },
    }),
    ...(runner.length && { runner: { inputs: runner, canaries } }),
    ...(changes && {
      definitions: { inputs: definitions, changed: changes.changed },
    }),
    selection,
    hits: [...hits.values()],
    ran,
    rerun: [...rerun].sort(),
    jobs,
    outputs: jobOutputs(jobs),
    shards: gate ? packing(ran, seconds) : {},
  }
}
