import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { schemaErrors } from "./schema.mjs"
import {
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
//
//   gate.mjs shadow --config <merge-gate.json> --inputs <dir> --results <dir>
//                   --needs <file> [--jobs <file>] [--earlier <file>]
//                   --out <dir>
//     The decision of a PR run in shadow mode. The full run gates; this
//     computes what a gated run would decide from the same results, and
//     writes decision.json, summary.md and comment.md to <dir>. <inputs>
//     holds the artifacts of the manifest and select jobs, <results> the test
//     artifacts, <needs> the `needs` context, <jobs> the jobs of this run
//     attempt from the GitHub API, <earlier> the jobs of the earlier attempts
//     of this run.

// The steps of the Lint and format job that run one check each, by the
// `<family>:<lane>:` prefix of its id. The step result is the check result.
// A test keeps these names equal to the steps in ci.yaml.
export const lintSteps = {
  "Run pnpm lint": "lint:oxlint:",
  "Run pnpm format:check": "lint:format:",
  "Reject unused files, exports and dependencies": "lint:knip:",
  "Run node scripts/ci/check-workflow-credentials.mjs":
    "policy:workflow-credentials:",
  "Run node scripts/ci/check-secret-jobs.mjs": "policy:secret-jobs:",
  "Run node scripts/ci/check-agent-harness.mjs": "policy:agent-harness:",
  "Reject skipped proof and owned mocks": "policy:test-policy:",
  "Reject slow UI motion": "policy:ui-motion:",
  "Reject racy Storybook play checks": "policy:story-play-timing:",
  "Reject non-Blacksmith runners": "policy:runners:",
  "Reject outside values in run scripts and workflows without permissions":
    "policy:workflow-inputs:",
}
// The step of the Lint and format job that the gated run always runs.
const ciScriptTests = "CI command regression tests"

// The result of each step above in this run, and of the CI script tests.
export function stepResults(jobs) {
  const results = new Map()
  for (const job of jobs?.jobs ?? []) {
    if (job.name !== "Lint and format") continue
    for (const step of job.steps ?? []) {
      const key =
        lintSteps[step.name] ??
        (step.name === ciScriptTests ? ciScriptTests : undefined)
      if (key)
        results.set(
          key,
          step.conclusion === "success"
            ? "passed"
            : step.conclusion === "failure"
              ? "failed"
              : "unknown",
        )
    }
  }
  return results
}

export function decideMode({ config, event, fork, changed }) {
  const full = (reason) => ({ mode: "full", reason })
  if (event !== "pull_request") return full(`event ${event}`)
  if (fork) return full("fork PR")
  // A change to one of these can change how the gate decides, so the run is
  // full: the workflow that runs the gate, its actions, its pin, and the code
  // that the gate and the runner execute. The manifest job runs the code of
  // the PR (`pnpm install`, `pnpm -s checks:list`), so a file that changes
  // how the manifest is made is here too: the package files, the lockfile,
  // the patches, and each file that scripts/checks/list.mjs runs outside
  // scripts/checks/ (a test keeps this list complete). Other workflows,
  // Markdown files and .node-version are not here: the selector reads them as
  // lane inputs (scripts/checks/lanes.mjs), and the toolchain is part of each
  // key.
  const inputs = changed.filter((path) =>
    [
      /^\.github\/workflows\/ci\.yaml$/,
      /^\.github\/actions\//,
      /^\.github\/merge-gate\.json$/,
      /^scripts\/checks\/(?:schema\/[^/]+\.json|[^/]+\.mjs)$/,
      /^scripts\/ci\/(?:vitest-launch|test-suite|graph-ready|prerequisites|storybook-play)\.mjs$/,
      /^scripts\/ci\/[^/]+\.json$/,
      /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/,
      /^patches\//,
      /^(?:apps|packages|examples)\/[^/]+\/package\.json$/,
      /^ops\/observability\/(?:railway-telemetry|cost-telemetry|hyperdx)\/package\.json$/,
      /^apps\/backend\/evals\/mcp\/(?:cases|gate)\.ts$/,
      /^apps\/ui\/\.storybook\/check-modules\.mjs$/,
      /^apps\/codesearch\/scripts\/run-vitest-contracts\.mjs$/,
    ].some((input) => input.test(path)),
  )
  if (inputs.length)
    return full(
      `gate inputs changed: ${inputs.slice(0, 5).join(", ")}${inputs.length > 5 ? ` and ${inputs.length - 5} more` : ""}`,
    )
  // Phase 1 has only the shadow mode: the full run gates.
  if (config.mode !== "shadow")
    return full("selector unavailable: merge-gate.json has no valid mode")
  if (
    !/^[0-9a-f]{40}$/.test(config.factory?.version ?? "") ||
    !/^[0-9a-f]{64}$/.test(config.factory?.sha256 ?? "")
  )
    return full("selector unavailable: no pinned factory release")
  return { mode: "select", reason: config.mode }
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
    if (step === "passed" || step === "failed") return step
    const job = runsInOf(id)?.job
    return `missing result (job ${job ?? "none"}: ${needs[job]?.result ?? "did not run"})`
  }
}

// The verdict of today's full run: every job of the run succeeded. A run
// with a cancelled job has no verdict for the agreement metrics.
export function fullVerdict(needs) {
  const jobs = Object.entries(needs).filter(
    ([name]) => !["merge-gate-manifest", "merge-gate-select"].includes(name),
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
  // The vercel job sets lane variables that the manifest job does not set
  // (GITHUB_TOKEN and VERCEL_TOKEN), so the key from the toolchain record does
  // not describe the run of its checks: their agent hits are not accepted.
  const accepted = (hit, lane) =>
    hit.source === "ci" ||
    (hit.source === "agent" &&
      config.acceptAgentResults === true &&
      lane !== "vercel")
  const ran = []
  const hit = []
  for (const check of selection.selected) {
    const found = hits.get(check.id)
    if (found && accepted(found, check.lane))
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
    default:
      return String(reason?.kind ?? "unknown")
  }
}

function readRecords(directory) {
  const records = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === "records.ndjson")
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

export function shadow({ config, inputs, records, needs, jobs, earlier, run }) {
  const mode = readJson(join(inputs, "mode.json"))
  const selection = readJson(join(inputs, "selection.json"))
  const select = needs["merge-gate-select"]?.result
  const full = fullVerdict(needs)
  const steps = stepResults(jobs)
  const result = fullRunResults(records, needs, steps)
  let fallback
  if (!mode)
    fallback = `manifest job ${needs["merge-gate-manifest"]?.result ?? "did not run"}`
  else if (mode.mode !== "select") fallback = mode.reason
  else if (select !== "success" || !selection) {
    // The select job writes why it failed: the download, the hash, the exit
    // code of the selector, or a timeout.
    const path = join(inputs, "select-cause.txt")
    const cause = existsSync(path)
      ? readFileSync(path, "utf8").trim().slice(0, 200)
      : ""
    fallback = `selector unavailable: ${cause || `select job ${select ?? "did not run"}`}`
  } else {
    const errors = schemaErrors(selection, "selection.v1", 1)
    if (errors.length)
      fallback = `selector unavailable: the record does not match the schema (${errors[0]})`
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
          }),
        )}\n`,
      )
    } else if (command === "shadow") {
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
      const decision = shadow({
        config,
        inputs: options.inputs,
        records: readRecords(options.results),
        needs: JSON.parse(readFileSync(options.needs, "utf8")),
        jobs: readJson(options.jobs),
        earlier: readJson(options.earlier),
        run,
      })
      mkdirSync(options.out, { recursive: true })
      writeFileSync(
        join(options.out, "decision.json"),
        `${JSON.stringify(decision, null, 2)}\n`,
      )
      writeFileSync(join(options.out, "summary.md"), summary(decision, runUrl))
      writeFileSync(join(options.out, "comment.md"), comment(decision, runUrl))
      process.stdout.write(
        `Merge gate (shadow): mode ${decision.mode}; full run ${decision.fullRun.verdict}; gated run ${decision.gatedRun.verdict}\n`,
      )
    } else throw new Error("Usage: gate.mjs mode|shadow --config <file> …")
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
