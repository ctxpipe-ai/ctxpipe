import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  accepted,
  fallbackOf,
  placeOf,
  plan,
  readStore,
  withJobChecks,
} from "./plan.mjs"
import {
  checkJobs,
  lintSteps,
  profiles,
  readTrace,
  runsInOf,
  shard,
  shardMinutes,
  storybookBuildMinutes,
  traceSeconds,
} from "./shard.mjs"

// The public rules of the merge gate (scripts/checks/README.md, Merge gate).
// It runs in jobs without dependencies, so it imports no package.
//
//   gate.mjs mode --config <merge-gate.json> --event <name> --fork <true|false>
//                 --changed <file>
//     Prints {"mode", "reason"}: `select` when the selector runs for this
//     run, else `full` and why. <file> lists the changed paths of the PR.
//     With `select`, "jobs" names the jobs of a ci.yaml change whose checks
//     all run. It runs git on the checkout (HEAD^1 and HEAD).
//
//   gate.mjs plan --config <merge-gate.json> --inputs <dir> --needs <file>
//                 --store <file> --fork <true|false> --out <dir>
//                 [--github-output <file>]
//     The plan of a PR run (plan.mjs): writes plan.json to <dir>, and the
//     outputs of the plan job (`mode`, `config`, `deploy`, and the checks of
//     each job that runs them) to <file>. <inputs> holds the artifacts of the
//     manifest, select and LLM jobs, <store> the PR store.
//
//   gate.mjs decide --config <merge-gate.json> --inputs <dir> --results <dir>
//                   --needs <file> [--jobs <file>] [--earlier <file>]
//                   [--deploy <file>] [--store <file>] --out <dir>
//     The decision of a PR run. In gate mode the gated run gates, and the
//     exit code is 1 when its verdict is fail. In shadow mode the full run
//     gates; this computes what a gated run would decide from the same
//     results. In gate mode with a full run, the exit code is 1 when the full
//     run fails. It writes decision.json, summary.md, comment.md and the next
//     PR store (store.json) to <dir>. <inputs> holds the artifacts of the
//     manifest, select, LLM and plan jobs, <results> the test artifacts,
//     <needs> the `needs` context, <jobs> the jobs of this run attempt from
//     the GitHub API, <earlier> the jobs of the earlier attempts of this
//     run, <deploy> the jobs of the newest PR Deploy run of the PR head.

// The steps of the job `Deploy PR environment (Railway + Neon)` of
// pr-deploy.yaml that run one deploy check each. A test keeps these names
// equal to the steps in pr-deploy.yaml.
export const deploySteps = {
  "Update Railway service config via GraphQL and deploy once":
    "deploy:preview:",
  "Smoke-test the preview UI": "deploy:preview-ui-smoke:",
}
// The step of the Lint and format job that the gated run always runs.
const ciScriptTests = "CI command regression tests"

// The result of a job or step conclusion.
const conclusion = (value) =>
  value === "success" ? "passed" : value === "failure" ? "failed" : "unknown"

// The result of each step above in this run, and of the CI script tests.
// Also the result of each image build: the matrix job `Production build
// (<name>)` of ci.yaml is a plain Docker build of the check
// `build:image-<name>:`, so the job result is the check result. And the
// result of each deploy check, from the steps of the PR Deploy run (`deploy`).
// A PR Deploy run that has not ended gives `pending` (no verdict yet). A
// deploy job that a failed job before it skipped gives `failed` for the
// deployment: it never came up. A run without a deploy run gives no result.
export function stepResults(jobs, deploy) {
  const results = new Map()
  if (deploy && deploy.status && deploy.status !== "completed")
    for (const prefix of Object.values(deploySteps))
      results.set(prefix, "pending")
  else if (deploy) {
    const list = deploy.jobs ?? []
    const job = list.find(
      (item) => item.name === "Deploy PR environment (Railway + Neon)",
    )
    if (job?.steps?.length) {
      for (const step of job.steps)
        if (deploySteps[step.name])
          results.set(deploySteps[step.name], conclusion(step.conclusion))
    } else if (
      list.some((item) => item.conclusion === "failure") &&
      (!job || job.conclusion === "skipped")
    )
      results.set("deploy:preview:", "failed")
  }
  for (const job of jobs?.jobs ?? []) {
    const image = /^Production build \((.+)\)$/.exec(job.name)?.[1]
    if (image) results.set(`build:image-${image}:`, conclusion(job.conclusion))
    if (job.name !== "Lint and format") continue
    for (const step of job.steps ?? []) {
      const key =
        lintSteps[step.name] ??
        (step.name === ciScriptTests ? ciScriptTests : undefined)
      if (key) results.set(key, conclusion(step.conclusion))
    }
  }
  return results
}

// The job of line i of ci.yaml when the line is in the `steps` of a job that
// a manifest check runs in (or in the Storybook build job, which they need);
// null for a blank or comment line; else undefined. A step or a job that
// only a full run uses (its `if:` needs `mode != 'gate'` or a matrix lane
// other than `selected`) is undefined too: a gated run does not run it, so
// only a full run can prove its change. It reads the indents of the
// workflow, not its YAML.
function jobOf(lines, i) {
  if (/^\s*(?:#|$)/.test(lines[i])) return null
  let key
  let job
  let header
  for (let j = i; j >= 0; j--) {
    const [, indent, name] = /^( *)([\w-]+):/.exec(lines[j]) ?? []
    if (name === undefined) continue
    if (indent.length === 4 && !job) key ??= name
    else if (indent.length === 2) {
      job ??= name
      header ??= j
    } else if (indent.length === 0) {
      if (
        name !== "jobs" ||
        !job ||
        key !== "steps" ||
        !(checkJobs.has(job) || job === "storybook-build")
      )
        return undefined
      break
    }
  }
  if (header === undefined) return undefined
  // The keys of the job before its steps, and the step of the line.
  const steps = lines.findIndex(
    (line, j) => j > header && /^ {4}steps:/.test(line),
  )
  const jobIf = lines.slice(header, steps).join("\n")
  if (jobIf.includes("mode != 'gate'") && !jobIf.includes("mode != 'gate' ||"))
    return undefined
  let start = i
  while (start > steps && !/^ {6}- /.test(lines[start])) start--
  let end = i + 1
  while (end < lines.length && !/^ {0,6}\S/.test(lines[end])) end++
  if (
    /mode != 'gate'|lane != 'selected'/.test(lines.slice(start, end).join("\n"))
  )
    return undefined
  return job
}

// The jobs that a change to ci.yaml touches, from the line ranges of its
// `git diff -U0` hunks on both sides, or undefined when one changed line is
// not in the `steps` of such a job.
function changedJobs(path, read, diff) {
  const sides = [read(path, "base"), read(path, "head")].map((text) =>
    text.split("\n"),
  )
  const jobs = new Set()
  for (const [, ...range] of diff(path).matchAll(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
  ))
    for (const [side, lines] of sides.entries()) {
      const start = Number(range[side * 2])
      const count = Number(range[side * 2 + 1] ?? 1)
      for (let n = start; n < start + count; n++) {
        const job = jobOf(lines, n - 1)
        if (job === undefined) return undefined
        if (job) jobs.add(job)
      }
    }
  return [...jobs].sort()
}

export function decideMode({ config, event, fork, changed, read, diff }) {
  const full = (reason) => ({ mode: "full", reason })
  if (event !== "pull_request") return full(`event ${event}`)
  if (fork) return full("fork PR")
  // A change to one of these can change how the gate decides, so the run is
  // full: the workflow that runs the gate, its actions, its pin, and the code
  // that the gate and the runner execute. The manifest job runs the code of
  // the PR (`pnpm install`, `pnpm -s checks:list`), so a file that changes
  // how the manifest is made is here too: .npmrc, the patches, and each file
  // that scripts/checks/list.mjs runs outside scripts/checks/ (a test keeps
  // this list complete). Package files and the lockfile are lane inputs that
  // the selector reads, not gate inputs. Other workflows, Markdown files and
  // .node-version are lane inputs too, and the toolchain is part of each key.
  let inputs = changed.filter((path) =>
    [
      /^\.github\/workflows\/ci\.yaml$/,
      /^\.github\/actions\//,
      /^\.github\/merge-gate\.json$/,
      /^scripts\/checks\/(?:schema\/[^/]+\.json|[^/]+\.mjs)$/,
      /^scripts\/ci\/(?:vitest-launch|test-suite|graph-ready|prerequisites|storybook-play)\.mjs$/,
      /^scripts\/ci\/[^/]+\.json$/,
      /^\.npmrc$/,
      /^patches\//,
      /^apps\/backend\/evals\/mcp\/(?:cases|gate)\.ts$/,
      /^apps\/ui\/\.storybook\/check-modules\.mjs$/,
      /^apps\/codesearch\/scripts\/run-vitest-contracts\.mjs$/,
    ].some((input) => input.test(path)),
  )
  // A change to ci.yaml only in the `steps` of check jobs runs
  // the selector; the shadow job then runs each check of those jobs.
  let jobs = []
  const scoped =
    inputs.join() === ".github/workflows/ci.yaml" &&
    changedJobs(inputs[0], read, diff)
  if (scoped) {
    jobs = scoped
    inputs = []
  }
  if (inputs.length)
    return full(
      `gate inputs changed: ${inputs.slice(0, 5).join(", ")}${inputs.length > 5 ? ` and ${inputs.length - 5} more` : ""}`,
    )
  // shadow: the full run gates and the gated verdict is beside it. gate: the
  // gated run gates (gate.mjs plan).
  if (!["shadow", "gate"].includes(config.mode))
    return full("selector unavailable: merge-gate.json has no valid mode")
  if (
    !/^[0-9a-f]{40}$/.test(config.factory?.version ?? "") ||
    !/^[0-9a-f]{64}$/.test(config.factory?.sha256 ?? "")
  )
    return full("selector unavailable: no pinned factory release")
  return { mode: "select", reason: config.mode, ...(jobs.length && { jobs }) }
}

// The result of each check id in the full run: its own record, else its
// step of the Lint and format job, else `missing result` with the result of
// its job. Each job of the full run writes a record for each check that it
// runs, so a check without one did not run, or its job lost the record.
export function fullRunResults(records, needs, steps = new Map()) {
  const results = new Map()
  for (const record of records) {
    const kept = results.get(record.id)
    const bad = (status) => status === "failed" || status === "error"
    if (!kept || (bad(record.status) && !bad(kept)))
      results.set(record.id, record.status)
  }
  return (id) => {
    if (results.has(id)) return results.get(id)
    const [family, lane] = id.split(":")
    const step = steps.get(`${family}:${lane}:`)
    if (["passed", "failed", "pending"].includes(step)) return step
    const job = runsInOf(id)?.job
    return `missing result (job ${job ?? "none"}: ${needs[job]?.result ?? "did not run"})`
  }
}

// The verdict of today's full run: every job of the run succeeded. A run
// with a cancelled job has no verdict for the agreement metrics.
export function fullVerdict(needs) {
  const jobs = Object.entries(needs).filter(
    ([name]) =>
      ![
        "merge-gate-manifest",
        "merge-gate-select",
        "merge-gate-llm",
        "merge-gate-plan",
      ].includes(name),
  )
  const failed = jobs
    .filter(([, job]) => job.result === "failure" || job.result === "cancelled")
    .map(([name]) => name)
  return {
    verdict: failed.length ? "fail" : "pass",
    failed,
    cancelled: jobs.some(([, job]) => job.result === "cancelled"),
  }
}

// What a gated run would decide on the same results. Each selected check needs
// one accepted result: an accepted hit, or its result in the full run (the
// gated run would run it).
export function gatedVerdict({
  selection,
  config,
  result,
  needs,
  steps = new Map(),
}) {
  const hits = new Map(
    (selection.cache?.hits ?? []).map((hit) => [hit.id, hit]),
  )
  const ran = []
  const hit = []
  for (const check of selection.selected) {
    const found = hits.get(check.id)
    if (found && accepted(found.source, check.lane, config))
      hit.push({
        id: check.id,
        class: found.source,
        hostKind: found.provenance.hostKind,
        createdAt: found.provenance.createdAt,
        fullRun: result(check.id),
      })
    else
      ran.push({
        id: check.id,
        reason: check.reason,
        result: result(check.id),
        ...(found && { refused: found.source }),
      })
  }
  // The jobs that run whatever the selection is.
  const failedAlwaysRun = [
    "production-builds",
    "packages",
    "migrate",
    "terraform-validate",
  ].filter((job) => ["failure", "cancelled"].includes(needs[job]?.result))
  if (steps.get(ciScriptTests) === "failed") failedAlwaysRun.push(ciScriptTests)
  const failedChecks = ran.some(
    (item) =>
      ["failed", "error"].includes(item.result) ||
      item.result.startsWith("missing result"),
  )
  return {
    verdict: failedChecks || failedAlwaysRun.length ? "fail" : "pass",
    failedChecks,
    ran,
    hits: hit,
    failedAlwaysRun,
  }
}

// The failed checks of the full run that the gated run would not run, and why.
// A failed check has a failed record, or a failed step of the Lint and format
// job. A check that the gated run would run also fails with an error record or
// without a record, as in the gated verdict. An omitted check or a hit with an
// error record or without a record is `unverified`: the full run did not prove
// it, and the gated run would not run it.
export function escapes({
  selection,
  records,
  gated,
  result,
  steps = new Map(),
}) {
  const ran = new Set(gated.ran.map((item) => item.id))
  const unproved = (status) =>
    status === "error" || status.startsWith("missing result")
  const hits = new Map(gated.hits.map((item) => [item.id, item]))
  const omitted = new Map(selection.omitted.map((item) => [item.id, item]))
  const known = [...selection.selected, ...selection.omitted].map(
    ({ id }) => id,
  )
  const failedSteps = [...steps]
    .filter(([, result]) => result === "failed")
    .map(([prefix]) => prefix)
  const failed = [
    ...new Set([
      ...records
        .filter((record) => record.status === "failed")
        .map((record) => record.id),
      ...known.filter((id) =>
        failedSteps.some((prefix) => id.startsWith(prefix)),
      ),
      ...gated.ran
        .filter((item) => unproved(item.result))
        .map((item) => item.id),
    ]),
  ].sort()
  const unverified = [
    ...gated.hits.map((item) => ({ id: item.id, result: item.fullRun })),
    ...selection.omitted.map(({ id }) => ({ id, result: result(id) })),
  ]
    .filter((item) => !failed.includes(item.id) && unproved(item.result))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    failed: failed.length,
    ran: failed.filter((id) => ran.has(id)).length,
    escaped: failed
      .filter((id) => !ran.has(id))
      .map((id) => ({
        id,
        why: hits.has(id)
          ? `hit (${hits.get(id).class})`
          : omitted.has(id)
            ? `omitted: ${omitted.get(id).reason}`
            : "not in the selection (stochastic or not in the manifest)",
      })),
    unverified,
  }
}

// The minutes of each job of this run, from the GitHub API listing.
function jobMinutes(jobs) {
  const minutes = new Map()
  for (const job of jobs?.jobs ?? []) {
    if (!job.started_at || !job.completed_at) continue
    const value =
      (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000
    minutes.set(job.name, (minutes.get(job.name) ?? 0) + Math.max(0, value))
  }
  return minutes
}

// Runner minutes and wall time: the full run as measured, and the gated run
// as estimated from the selection, the shards and the measured setup times.
// The always-run jobs start with the manifest job; the profile jobs start
// after the select job.
export function cost({ ranIds, seconds, jobs }) {
  const round = (value) => Math.round(value * 10) / 10
  const minutes = jobMinutes(jobs)
  const matching = (match) =>
    [...minutes].filter(([name]) => match(name)).map(([, value]) => value)
  const sum = (match) =>
    matching(match).reduce((total, value) => total + value, 0)
  const shadowJob = (name) => /^Merge gate/.test(name)
  const alwaysRunJob = (name) =>
    /^(Production build|Runnable packages|Migrations|Terraform)/.test(name)
  const manifest = minutes.get("Merge gate manifest") ?? 0
  const select = minutes.get("Merge gate selection") ?? 0
  const shards = shard(ranIds, seconds)
  const longest = Math.max(
    0,
    ...Object.entries(shards).flatMap(([profile, list]) =>
      list.map(
        (item) =>
          profiles[profile].setupMinutes +
          item.seconds / 60 +
          (profile === "storybook" ? storybookBuildMinutes : 0),
      ),
    ),
  )
  const listed = (jobs?.jobs ?? []).filter(
    (job) => job.started_at && job.completed_at && !shadowJob(job.name),
  )
  const wall = listed.length
    ? (Math.max(...listed.map((job) => Date.parse(job.completed_at))) -
        Math.min(...listed.map((job) => Date.parse(job.started_at)))) /
      60_000
    : undefined
  const profileMinutes = shardMinutes(shards)
  // The CI script tests run in the Lint and format job, on each run.
  const always = sum(alwaysRunJob) + 0.7
  return {
    fullRunMinutes: round(sum((name) => !shadowJob(name))),
    gatedRunMinutes: round(manifest + select + always + profileMinutes),
    parts: {
      manifestAndSelect: round(manifest + select),
      alwaysRun: round(always),
      profiles: profileMinutes,
    },
    shards: Object.fromEntries(
      Object.entries(shards).map(([profile, list]) => [
        profile,
        list.map((item) => ({
          checks: item.ids.length,
          seconds: item.seconds,
        })),
      ]),
    ),
    fullRunWallMinutes: wall === undefined ? null : round(wall),
    gatedRunWallMinutes: round(
      Math.max(manifest + select + longest, ...matching(alwaysRunJob)),
    ),
  }
}

// A control, bidirectional, zero-width or line separator character.
const hidden = (character) => {
  const n = character.codePointAt(0)
  return (
    n < 0x20 ||
    (n >= 0x7f && n <= 0x9f) ||
    n === 0x61c ||
    (n >= 0x200b && n <= 0x200f) ||
    (n >= 0x2028 && n <= 0x202e) ||
    (n >= 0x2060 && n <= 0x2069) ||
    n === 0xfeff
  )
}

// Text from a PR (file names, reasons) as a Markdown code span that cannot
// break a table, start a mention or hide characters.
export function code(text) {
  const clean = [...String(text)]
    .map((character) => (hidden(character) ? " " : character))
    .join("")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|")
  return `\`${clean.length > 200 ? `${clean.slice(0, 200)}…` : clean}\``
}

// One line for a selection reason.
export function describe(reason) {
  const range = (r) => `${r.path}:${r.lines?.[0]}-${r.lines?.[1]}`
  const share = (r) => ` (${r.chosen} of ${r.candidates})`
  switch (reason?.kind) {
    case "changed":
      return "the test file changed"
    case "imports":
      return `imports ${reason.chain?.at(-1) ?? "a changed file"}`
    case "unparsed":
      return `imports ${reason.chain?.at(-1) ?? "a file"}, which does not parse`
    case "input":
      return `lane input ${reason.input}`
    case "uncovered":
      return `uncovered ${reason.path}`
    case "covers":
      return `covers ${range(reason)}${share(reason)}`
    case "observes":
      return `observes ${range(reason)}${share(reason)}`
    case "untraced":
      return `untraced, imports ${reason.chain?.at(-1) ?? "a changed file"}`
    case "touches":
      return `${reason.access}s table ${reason.table} of ${reason.path}${share(reason)}`
    case "applies":
      return `migration ${reason.path} applies${reason.table ? ` (new table ${reason.table})` : ""}${share(reason)}`
    case "reads":
      return `reads ${reason.path}${share(reason)}`
    case "jobs":
      return `ci.yaml changed in job ${reason.jobs?.join(", ")}`
    case "added":
      return `added by the LLM: ${reason.why}`
    case "contract":
      return `contract test that executes ${reason.path}`
    case "failedWith":
      return `failed ${reason.times} times when ${reason.path} changed`
    case "package":
      return `package ${reason.package} changed (${reason.change})`
    case "tools":
      return `MCP tools ${reason.tools?.join(", ")} reach ${reason.path}`
    default:
      return String(reason?.kind ?? "unknown")
  }
}

function readRecords(directory, name = "records.ndjson") {
  const records = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === name)
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue
          const record = JSON.parse(line)
          if (
            typeof record.id === "string" &&
            ["passed", "failed", "skipped", "error"].includes(record.status)
          )
            records.push({ id: record.id, status: record.status })
        }
    }
  }
  if (existsSync(directory)) walk(directory)
  return records
}

const readJson = (path) =>
  path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined

// The age in days of the trace, from the selector note.
const traceAge = (notes) =>
  Number(/\((\d+) days old/.exec(notes.join("\n"))?.[1] ?? Number.NaN)

// The jobs that failed in an earlier attempt of this run and passed in this
// one: a rerun of the same head passed them, so they are flakes.
export function flakyJobs(jobs, earlier) {
  const now = new Map((jobs?.jobs ?? []).map((job) => [job.name, job]))
  return [
    ...new Set(
      (earlier?.jobs ?? [])
        .filter(
          (job) =>
            job.conclusion === "failure" &&
            now.get(job.name)?.conclusion === "success",
        )
        .map((job) => job.name),
    ),
  ].sort()
}

export function shadow({
  config,
  inputs,
  records,
  needs,
  jobs,
  earlier,
  deploy,
  run,
}) {
  const full = fullVerdict(needs)
  const steps = stepResults(jobs, deploy)
  const result = fullRunResults(records, needs, steps)
  // The plan job combines the selection of the select job, the LLM job and
  // the PR store. Without its record, the selection of the select job stays.
  const planned = readJson(join(inputs, "plan.json"))
  let selection
  let fallback
  if (planned) {
    selection = planned.selection
    fallback = selection ? undefined : planned.reason
  } else {
    const mode = readJson(join(inputs, "mode.json"))
    selection = readJson(join(inputs, "selection.json"))
    fallback = fallbackOf({ mode, selection, inputs, needs })
    if (!fallback && mode.jobs?.length)
      selection = withJobChecks(selection, mode.jobs)
  }
  const decision = {
    schemaVersion: 1,
    mode: fallback ? "full" : "shadow",
    reason:
      fallback ?? "shadow: the full run gates; the gated verdict is beside it",
    factory: config.factory?.version ?? null,
    acceptAgentResults: config.acceptAgentResults === true,
    run,
    fullRun: full,
  }
  if (fallback) {
    // A gated run would be this full run.
    decision.gatedRun = { verdict: full.verdict }
    return decision
  }
  const gated = gatedVerdict({ selection, config, result, needs, steps })
  const trace = existsSync(join(inputs, "trace.json.gz"))
    ? readTrace(join(inputs, "trace.json.gz"))
    : undefined
  const omittedByLane = {}
  for (const item of selection.omitted) {
    omittedByLane[item.lane] ??= {}
    omittedByLane[item.lane][item.reason] =
      (omittedByLane[item.lane][item.reason] ?? 0) + 1
  }
  const hitClasses = {}
  for (const hit of selection.cache?.hits ?? [])
    hitClasses[hit.source] = (hitClasses[hit.source] ?? 0) + 1
  const recall = escapes({ selection, records, gated, result, steps })
  // Compares a full-run failure with a gated-run failure: `agree`, `escape`
  // (only the full run failed) or `false failure` (only the gated run failed).
  const agreement = (fullFailed, gatedFailed) =>
    fullFailed === gatedFailed
      ? "agree"
      : fullFailed
        ? "escape"
        : "false failure"
  Object.assign(decision, {
    selection: {
      variant: selection.variant,
      base: selection.base,
      trace: selection.trace?.commit ?? null,
      traceAgeDays: Number.isNaN(traceAge(selection.notes))
        ? null
        : traceAge(selection.notes),
      counts: selection.counts,
      shared: selection.cache?.shared ?? false,
      degraded: selection.degraded ?? false,
      notes: selection.notes,
      cacheNotes: selection.cache?.notes ?? [],
      selectSeconds: Math.round((selection.timingsMs?.total ?? 0) / 100) / 10,
    },
    gatedRun: {
      verdict: gated.verdict,
      failedAlwaysRun: gated.failedAlwaysRun,
    },
    ran: gated.ran.map((item) => ({
      ...item,
      reason: describe(item.reason),
    })),
    hits: gated.hits,
    hitClasses,
    unkeyed: selection.cache?.unkeyed ?? [],
    omitted: {
      byLane: omittedByLane,
      stochastic: selection.counts.stochasticOmitted ?? 0,
    },
    metrics: {
      // A cancelled run has no verdict, so the report counts it apart.
      // Selection: only the checks count (a failed check of the full run
      // against a failed check that the gated run would run). Overall: the
      // verdicts, with the always-run jobs.
      selectionAgreement: full.cancelled
        ? "cancelled"
        : agreement(recall.failed > 0, gated.failedChecks),
      overallAgreement: full.cancelled
        ? "cancelled"
        : agreement(full.verdict === "fail", gated.verdict === "fail"),
      flakyJobs: flakyJobs(jobs, earlier),
      recall,
      contradictions: gated.hits
        .filter((item) => item.fullRun === "failed")
        .map(({ id, class: kind }) => ({ id, class: kind })),
      cost: cost({
        ranIds: gated.ran.map((item) => item.id),
        seconds: traceSeconds(trace),
        jobs,
      }),
    },
  })
  return decision
}

// The decision of a PR run in gate mode: the gated run gates. Each check of
// the plan ran in its job of this run, and each other selected check has an
// accepted hit. A check that another workflow runs (the preview deploy, the
// MCP evals, the Terraform plan) has the status of that workflow and is not
// part of this verdict. `reruns` are the records of the one rerun of each
// failed check whose key has a stored pass.
export function gateDecision({
  config,
  planned,
  records,
  reruns = [],
  needs,
  jobs,
  deploy,
  run,
  store,
  seconds = new Map(),
  now = new Date(),
}) {
  const steps = stepResults(jobs, deploy)
  const result = fullRunResults(records, needs, steps)
  const selection = planned.selection
  const reasons = new Map(selection.selected.map((c) => [c.id, c.reason]))
  const rerunOf = new Map(reruns.map((record) => [record.id, record.status]))
  const ran = []
  const external = []
  for (const id of planned.ran) {
    const reason = describe(reasons.get(id))
    const { workflow } = placeOf(id)
    if (workflow) external.push({ id, reason, workflow })
    else
      ran.push({
        id,
        reason,
        result: result(id),
        ...(rerunOf.has(id) && { rerun: rerunOf.get(id) }),
      })
  }
  // The jobs that run on each gated run.
  const failedAlwaysRun = ["lint", "terraform-validate", "migrate"].filter(
    (job) => ["failure", "cancelled"].includes(needs[job]?.result),
  )
  if (steps.get(ciScriptTests) === "failed") failedAlwaysRun.push(ciScriptTests)
  const bad = (status) =>
    ["failed", "error"].includes(status) || status.startsWith("missing result")
  const failedChecks = ran.filter((item) => bad(item.result))
  // A failed check whose key has a stored pass contradicts that pass. Its
  // job ran it once more: a second failure quarantines the key in the PR
  // store, and a pass is a flake.
  const contested = new Set(planned.rerun ?? [])
  const contradictions = ran
    .filter((item) => contested.has(item.id) && item.result === "failed")
    .map((item) => ({
      id: item.id,
      rerun: item.rerun ?? "none",
      confirmed: ["failed", "error"].includes(item.rerun),
    }))
  const next = nextStore({ store, selection, ran, contradictions, run, now })
  const all = [...selection.selected, ...selection.omitted].map(({ id }) => id)
  const measured = jobMinutes(jobs)
  const round = (value) => Math.round(value * 10) / 10
  const omittedByLane = {}
  for (const item of selection.omitted) {
    omittedByLane[item.lane] ??= {}
    omittedByLane[item.lane][item.reason] =
      (omittedByLane[item.lane][item.reason] ?? 0) + 1
  }
  return {
    decision: {
      schemaVersion: 1,
      mode: "gate",
      reason: "gate: the gated run gates",
      factory: config.factory?.version ?? null,
      acceptAgentResults: config.acceptAgentResults === true,
      acceptPrResults: config.acceptPrResults === true,
      run,
      gatedRun: {
        verdict:
          failedChecks.length || failedAlwaysRun.length ? "fail" : "pass",
        failedChecks: failedChecks.map((item) => item.id),
        failedAlwaysRun,
      },
      selection: {
        variant: selection.variant,
        base: selection.base,
        trace: selection.trace?.commit ?? null,
        counts: selection.counts,
        shared: selection.cache?.shared ?? false,
        notes: selection.notes,
        cacheNotes: selection.cache?.notes ?? [],
        llm: selection.llm ?? null,
      },
      ran,
      hits: planned.hits.map((hit) => ({
        id: hit.id,
        class: hit.source,
        hostKind: hit.provenance.hostKind,
        createdAt: hit.provenance.createdAt,
        ...(hit.provenance.run && { run: hit.provenance.run }),
      })),
      external,
      omitted: {
        byLane: omittedByLane,
        stochastic: selection.counts.stochasticOmitted ?? 0,
      },
      contradictions,
      store: {
        entries: next.entries.length,
        quarantined: next.quarantined.length,
      },
      cost: {
        // This run as measured, without the merge gate job, and the full
        // run as estimated from the shards of every check of the manifest
        // (tests and setup, without the builds).
        gatedRunMinutes: round(
          [...measured]
            .filter(([name]) => !/^Merge gate$/.test(name))
            .reduce((sum, [, value]) => sum + value, 0),
        ),
        fullRunMinutesEstimate: round(
          shardMinutes(shard(all, seconds)) +
            [...measured]
              .filter(([name]) =>
                /^(Lint and format|Migrations|Terraform)/.test(name),
              )
              .reduce((sum, [, value]) => sum + value, 0),
        ),
      },
    },
    store: next,
  }
}

// The PR store after this run: the passes of the earlier runs, and each
// check of this run that passed under a key. A check of this run that failed
// under a key removes the stored pass of that key, so a later gated run runs
// it again. A confirmed contradiction quarantines its
// key: no gated run of this PR accepts a stored pass for it. The store keeps
// the newest 5000 passes.
export function nextStore({ store, selection, ran, contradictions, run, now }) {
  const keys = new Map(
    [...(selection.cache?.hits ?? []), ...(selection.cache?.misses ?? [])].map(
      (item) => [item.id, item.key],
    ),
  )
  const quarantined = new Set(store.quarantined)
  for (const item of contradictions)
    if (item.confirmed && keys.has(item.id)) quarantined.add(keys.get(item.id))
  const entries = new Map(
    store.entries.map((entry) => [`${entry.id}\0${entry.key}`, entry]),
  )
  for (const item of ran) {
    const key = keys.get(item.id)
    if (!key) continue
    entries.delete(`${item.id}\0${key}`)
    if (item.result !== "passed") continue
    entries.set(`${item.id}\0${key}`, {
      id: item.id,
      key,
      run: String(run.id),
      createdAt: now.toISOString(),
    })
  }
  return {
    schemaVersion: 1,
    entries: [...entries.values()]
      .filter((entry) => !quarantined.has(entry.key))
      .slice(-5000),
    quarantined: [...quarantined].sort(),
  }
}

// The text of a gate-mode decision: the job summary (`limit` rows for each
// table) or the PR comment (fewer rows, in collapsed sections).
export function gateText(
  decision,
  runUrl,
  { limit = 300, comment = false } = {},
) {
  const s = decision.selection
  const g = decision.gatedRun
  const lines = comment ? [marker, "### Merge gate"] : ["## Merge gate"]
  const classes = {}
  for (const hit of decision.hits)
    classes[hit.class] = (classes[hit.class] ?? 0) + 1
  lines.push(
    "",
    `**Verdict:** ${g.verdict}${g.failedChecks.length ? ` (failed checks: ${g.failedChecks.slice(0, 10).map(code).join(", ")}${g.failedChecks.length > 10 ? " and more" : ""})` : ""}${g.failedAlwaysRun.length ? ` (failed always-run jobs: ${g.failedAlwaysRun.map(code).join(", ")})` : ""}.`,
    "",
    `Selected ${s.counts.selected} of ${s.counts.total} checks (variant ${s.variant}, factory ${code((decision.factory ?? "").slice(0, 12))}): ${decision.ran.length} ran, ${decision.hits.length} hits (${
      Object.entries(classes)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }), ${decision.external.length} in other workflows, ${s.counts.total - s.counts.selected} omitted.`,
    "",
    `**Runner minutes:** this run ${decision.cost.gatedRunMinutes}; a full run about ${decision.cost.fullRunMinutesEstimate} (estimate of the tests and their setup, without builds).`,
  )
  const llm = s.llm
  if (llm)
    lines.push(
      "",
      llm.fallback
        ? `**LLM stage:** not used (${code(llm.fallback)}); the deterministic selection stays.`
        : `**LLM stage:** ${code(llm.change ?? "")} (${code(llm.kind ?? "")}); kept ${llm.kept?.length ?? 0}, dropped ${llm.dropped?.length ?? 0}, added ${llm.added?.length ?? 0}, coverage floor ${llm.floor ?? 0}; ${llm.cached ? "cached answer" : `${Math.round((llm.latencyMs ?? 0) / 100) / 10} s`}, USD ${(llm.usage?.costUsd ?? 0).toFixed(4)}.${llm.behaviors?.length ? ` Behaviors: ${llm.behaviors.map(code).join(", ")}.` : ""}`,
    )
  if (decision.contradictions.length)
    lines.push(
      "",
      `**Contradictions** (a stored pass, and the check failed): ${decision.contradictions.map((item) => `${code(item.id)} (rerun ${item.rerun}${item.confirmed ? ", quarantined in this PR" : ""})`).join(", ")}.`,
    )
  const table = (title, header, rows) => {
    if (comment)
      lines.push(
        "",
        `<details><summary>${title} (${rows.length})</summary>`,
        "",
      )
    else lines.push("", `### ${title}`, "")
    if (!rows.length) lines.push("None.")
    else {
      lines.push(header, header.replace(/[^|]+/g, " --- "))
      for (const row of rows.slice(0, limit)) lines.push(row)
      if (rows.length > limit)
        lines.push(
          "",
          `And ${rows.length - limit} more: see the job summary or the artifact \`merge-gate-decision\`.`,
        )
    }
    if (comment) lines.push("", "</details>")
  }
  const order = (item) =>
    ["failed", "error"].includes(item.result) ||
    item.result.startsWith("missing")
      ? 0
      : 1
  table(
    "Ran",
    "| Check | Reason | Result |",
    [...decision.ran]
      .sort((a, b) => order(a) - order(b))
      .map(
        (item) =>
          `| ${code(item.id)} | ${code(item.reason)} | ${item.result}${item.rerun ? ` (rerun ${item.rerun})` : ""} |`,
      ),
  )
  table(
    "Hits (not run)",
    "| Check | Class | Host | Time |",
    decision.hits.map(
      (item) =>
        `| ${code(item.id)} | ${item.class}${item.run ? ` (run ${item.run})` : ""} | ${item.hostKind} | ${code(item.createdAt)} |`,
    ),
  )
  if (llm && !llm.fallback)
    table("LLM decisions", "| Check | Decision | Reason |", [
      ...(llm.dropped ?? []).map(
        (item) => `| ${code(item.id)} | dropped | ${code(item.reason)} |`,
      ),
      ...(llm.added ?? []).map(
        (item) => `| ${code(item.id)} | added | ${code(item.reason)} |`,
      ),
    ])
  table(
    "In other workflows",
    "| Check | Reason | Workflow |",
    decision.external.map(
      (item) =>
        `| ${code(item.id)} | ${code(item.reason)} | ${item.workflow} |`,
    ),
  )
  table(
    "Omitted",
    "| Lane | Reason | Checks |",
    Object.entries(decision.omitted.byLane).flatMap(([lane, reasons]) =>
      Object.entries(reasons).map(
        ([reason, count]) => `| ${code(lane)} | ${code(reason)} | ${count} |`,
      ),
    ),
  )
  if (!comment) {
    const notes = [...s.notes, ...s.cacheNotes]
    if (notes.length) {
      lines.push("", "### Notes", "")
      for (const note of notes.slice(0, 50)) lines.push(`- ${code(note)}`)
    }
  }
  if (runUrl) lines.push("", `[Run](${runUrl})`)
  const text = `${lines.join("\n")}\n`
  // GitHub refuses a comment over 65536 characters.
  return comment && text.length > 60000
    ? `${text.slice(0, 60000)}\n\n</details>\n\nThe comment is cut: see the job summary.${runUrl ? ` [Run](${runUrl})` : ""}\n`
    : text
}

export function summary(decision, runUrl) {
  const lines = ["## Merge gate (shadow)", ""]
  const gated = decision.gatedRun.verdict
  lines.push(
    decision.mode === "full"
      ? `**Mode:** full (${code(decision.reason)}). The full run gates.`
      : `**Mode:** full (shadow); gated run would: **${gated}**. The full run gates.`,
    "",
    `**Full run:** ${decision.fullRun.verdict}${decision.fullRun.failed.length ? ` (failed: ${decision.fullRun.failed.map(code).join(", ")})` : ""}`,
    "",
    `Factory ${decision.factory ? code(decision.factory.slice(0, 12)) : "not pinned"}, merge revision ${code(decision.run.sha ?? "")}${decision.selection ? `, base ${code(decision.selection.base.slice(0, 12))}` : ""}.`,
  )
  if (decision.mode === "full") return `${lines.join("\n")}\n`
  const s = decision.selection
  const m = decision.metrics
  lines.push(
    "",
    `Variant ${s.variant}${s.trace ? `, trace ${code(s.trace.slice(0, 12))}${s.traceAgeDays === null ? "" : ` (${s.traceAgeDays} days old)`}` : ", no trace"}. Selected ${s.counts.selected} of ${s.counts.total} checks in ${s.selectSeconds} s. Shared store: ${s.shared ? "answered" : "not available"}.`,
    "",
    `**Gated run:** ${decision.ran.length} would run, ${decision.hits.length} hits (${
      Object.entries(decision.hitClasses)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }). Agreement: selection ${m.selectionAgreement}, overall ${m.overallAgreement}${m.flakyJobs.length ? ` (flaky jobs: ${m.flakyJobs.map(code).join(", ")})` : ""}. Failed checks of the full run that the gated run would run: ${m.recall.ran} of ${m.recall.failed}. Omitted or hit checks that the full run did not prove: ${m.recall.unverified.length}. Hit contradictions: ${m.contradictions.length}.`,
    "",
    `**Runner minutes:** gated about ${m.cost.gatedRunMinutes} (manifest and select ${m.cost.parts.manifestAndSelect}, always-run ${m.cost.parts.alwaysRun}, checks ${m.cost.parts.profiles}); full run ${m.cost.fullRunMinutes}. **Wall time:** gated about ${m.cost.gatedRunWallMinutes} min; full run ${m.cost.fullRunWallMinutes ?? "?"} min.`,
  )
  const limit = 300
  const table = (title, header, rows) => {
    lines.push("", `### ${title}`, "")
    if (!rows.length) return lines.push("None.")
    lines.push(header, header.replace(/[^|]+/g, " --- "))
    for (const row of rows.slice(0, limit)) lines.push(row)
    if (rows.length > limit)
      lines.push(
        "",
        `And ${rows.length - limit} more: see the artifact \`merge-gate-decision\`.`,
      )
  }
  table(
    "Selected and run",
    "| Check | Reason | Full-run result |",
    decision.ran.map(
      (item) =>
        `| ${code(item.id)} | ${code(item.reason)}${item.refused ? ` (${item.refused} hit not accepted)` : ""} | ${item.result} |`,
    ),
  )
  table(
    "Hits (not run)",
    "| Check | Class | Host | Time | Full-run result |",
    decision.hits.map(
      (item) =>
        `| ${code(item.id)} | ${item.class} | ${item.hostKind} | ${code(item.createdAt)} | ${item.fullRun} |`,
    ),
  )
  table(
    "Omitted",
    "| Lane | Reason | Checks |",
    Object.entries(decision.omitted.byLane).flatMap(([lane, reasons]) =>
      Object.entries(reasons).map(
        ([reason, count]) => `| ${code(lane)} | ${code(reason)} | ${count} |`,
      ),
    ),
  )
  lines.push(
    "",
    `Stochastic checks omitted (never selected, never cached): ${decision.omitted.stochastic}.`,
  )
  if (m.recall.escaped.length)
    table(
      "Failed in the full run, not run by the gated run",
      "| Check | Why |",
      m.recall.escaped.map(
        (item) => `| ${code(item.id)} | ${code(item.why)} |`,
      ),
    )
  if (m.recall.unverified.length)
    table(
      "Not proved by the full run (an error or no record), not run by the gated run",
      "| Check | Full-run result |",
      m.recall.unverified
        .slice(0, 50)
        .map((item) => `| ${code(item.id)} | ${code(item.result)} |`),
    )
  const notes = [
    ...s.notes,
    ...s.cacheNotes,
    ...(s.degraded
      ? [
          "degraded: a changed file outside the import graph widened the selection",
        ]
      : []),
    ...decision.unkeyed.map((item) => `no key for ${item.id}: ${item.reason}`),
  ]
  if (notes.length) {
    lines.push("", "### Notes", "")
    for (const note of notes.slice(0, 50)) lines.push(`- ${code(note)}`)
  }
  if (runUrl) lines.push("", `[Run](${runUrl})`)
  return `${lines.join("\n")}\n`
}

export const marker = "<!-- merge-gate -->"

export function comment(decision, runUrl) {
  const lines = [marker, "### Merge gate (shadow)", ""]
  if (decision.mode === "full")
    lines.push(
      `Mode: full (${code(decision.reason)}). The full run gates: **${decision.fullRun.verdict}**.`,
    )
  else {
    const s = decision.selection
    const m = decision.metrics
    lines.push(
      `Mode: full (shadow). Full run: **${decision.fullRun.verdict}**. Gated run would: **${decision.gatedRun.verdict}**.`,
      "",
      `Selected ${s.counts.selected} of ${s.counts.total} checks (variant ${s.variant}): ${decision.ran.length} would run, ${decision.hits.length} hits (${
        Object.entries(decision.hitClasses)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }), ${s.counts.total - s.counts.selected} omitted.`,
      "",
      `Runner minutes: gated about ${m.cost.gatedRunMinutes}, full run ${m.cost.fullRunMinutes}.`,
    )
    if (m.contradictions.length)
      lines.push(
        "",
        `Hit contradictions: ${m.contradictions.map((item) => code(item.id)).join(", ")}.`,
      )
  }
  if (runUrl) lines.push("", `[Decision details](${runUrl})`)
  return `${lines.join("\n")}\n`
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
}

function args(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 2) {
    if (!list[i].startsWith("--") || list[i + 1] === undefined)
      throw new Error(`Bad argument ${list[i]}`)
    out[list[i].slice(2)] = list[i + 1]
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    const [command, ...rest] = process.argv.slice(2)
    const options = args(rest)
    const config = JSON.parse(readFileSync(options.config, "utf8"))
    if (command === "mode") {
      const changed = readFileSync(options.changed, "utf8")
        .split("\n")
        .filter(Boolean)
      process.stdout.write(
        `${JSON.stringify(
          decideMode({
            config,
            event: options.event,
            fork: options.fork === "true",
            changed,
            // A pull_request run checks out the merge revision; its first
            // parent is main.
            read: (path, side) =>
              side === "base"
                ? git(["show", `HEAD^1:${path}`])
                : readFileSync(path, "utf8"),
            diff: (path) => git(["diff", "-U0", "HEAD^1", "HEAD", "--", path]),
          }),
        )}\n`,
      )
    } else if (command === "plan") {
      const planned = plan({
        config,
        inputs: options.inputs,
        needs: JSON.parse(readFileSync(options.needs, "utf8")),
        store: readStore(readJson(options.store)),
        fork: options.fork === "true",
      })
      mkdirSync(options.out, { recursive: true })
      writeFileSync(
        join(options.out, "plan.json"),
        `${JSON.stringify(planned, null, 2)}\n`,
      )
      // The outputs of the plan job: each value is one line of JSON.
      const outputs = {
        mode: planned.mode,
        config: planned.config,
        deploy: String(planned.deploy),
        ...planned.outputs,
      }
      if (options["github-output"])
        writeFileSync(
          options["github-output"],
          Object.entries(outputs)
            .map(([name, value]) => `${name}=${value}\n`)
            .join(""),
          { flag: "a" },
        )
      process.stdout.write(
        `Merge gate plan: mode ${planned.mode} (${planned.reason}); ${planned.ran?.length ?? "all"} checks run; jobs: ${Object.keys(planned.outputs).join(", ") || "none"}; deploy ${planned.deploy}\n`,
      )
    } else if (command === "decide") {
      const env = process.env
      const event = readJson(env.GITHUB_EVENT_PATH)
      const run = {
        id: env.GITHUB_RUN_ID,
        attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
        pr: event?.pull_request?.number ?? null,
        sha: env.GITHUB_SHA,
      }
      const runUrl =
        env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined
      const planned = readJson(join(options.inputs, "plan.json"))
      const needs = JSON.parse(readFileSync(options.needs, "utf8"))
      const store = readStore(readJson(options.store))
      const tracePath = join(options.inputs, "trace.json.gz")
      let decision
      let next = store
      if (planned?.mode === "gate") {
        const out = gateDecision({
          config,
          planned,
          records: readRecords(options.results),
          reruns: readRecords(options.results, "rerun.ndjson"),
          needs,
          jobs: readJson(options.jobs),
          deploy: readJson(options.deploy),
          run,
          store,
          seconds: existsSync(tracePath)
            ? traceSeconds(readTrace(tracePath))
            : new Map(),
        })
        decision = out.decision
        next = out.store
      } else {
        const records = readRecords(options.results)
        decision = shadow({
          config,
          inputs: options.inputs,
          records,
          needs,
          jobs: readJson(options.jobs),
          earlier: readJson(options.earlier),
          deploy: readJson(options.deploy),
          run,
        })
        // The full run proves each selected check that it ran, so its pass
        // goes to the PR store too.
        if (planned?.selection && decision.ran)
          next = nextStore({
            store,
            selection: planned.selection,
            ran: decision.ran,
            contradictions: [],
            run,
            now: new Date(),
          })
        // A check that failed in the full run loses each stored pass, so a
        // later gated run cannot accept it. After a selector outage the run
        // has no keys, so the rule removes the passes of every key.
        const failed = new Set(
          records
            .filter((record) => ["failed", "error"].includes(record.status))
            .map((record) => record.id),
        )
        next = {
          ...next,
          entries: next.entries.filter((entry) => !failed.has(entry.id)),
        }
      }
      mkdirSync(options.out, { recursive: true })
      writeFileSync(
        join(options.out, "decision.json"),
        `${JSON.stringify(decision, null, 2)}\n`,
      )
      writeFileSync(
        join(options.out, "store.json"),
        `${JSON.stringify(next)}\n`,
      )
      const gated = decision.mode === "gate"
      writeFileSync(
        join(options.out, "summary.md"),
        gated ? gateText(decision, runUrl) : summary(decision, runUrl),
      )
      writeFileSync(
        join(options.out, "comment.md"),
        gated
          ? gateText(decision, runUrl, { limit: 25, comment: true })
          : comment(decision, runUrl),
      )
      // In gate mode this job is the required status: it fails with the
      // gated verdict, or with the verdict of a full run.
      const verdict = gated
        ? decision.gatedRun.verdict
        : decision.fullRun.verdict
      process.stdout.write(
        `Merge gate: config ${config.mode}; mode ${decision.mode}; verdict ${verdict}\n`,
      )
      if (config.mode === "gate" && verdict === "fail") process.exitCode = 1
    } else throw new Error("Usage: gate.mjs mode|plan|decide --config <file> …")
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
