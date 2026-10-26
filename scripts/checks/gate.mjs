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
//                   --needs <file> [--jobs <file>] --out <dir>
//     The decision of a PR run in shadow mode. The full run gates; this
//     computes what a gated run would decide from the same results, and
//     writes decision.json, summary.md and comment.md to <dir>. <inputs>
//     holds the artifacts of the manifest and select jobs, <results> the test
//     artifacts, <needs> the `needs` context, <jobs> the jobs of this run
//     from the GitHub API.

// A change to one of these can change how checks are selected or run, so the
// run is full. The PR then shows the change of the rule in its diff.
const gateInputs = [
  /^\.github\//,
  /^scripts\/checks\//,
  /^scripts\/ci\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^\.node-version$/,
]

// The jobs that run whatever the selection is. The gate needs them.
const alwaysRun = [
  "production-builds",
  "packages",
  "migrate",
  "terraform-validate",
]
// The CI script tests run in the Lint and format job, on each run.
const ciScriptTestMinutes = 0.7

// The job of today's full run that runs each check. A check without its own
// result record passed when its job succeeded: the job ran every check of
// its lanes. Otherwise its result is unknown.
const jobOf = (id) => {
  const [family, lane] = id.split(":")
  if (family === "lint" || family === "policy") return "lint"
  if (family === "typecheck") return "typecheck"
  if (family === "storybook")
    return lane === "golden" ? "storybook-golden" : "storybook-plays"
  return {
    backend: "test-shards",
    contracts: "test-shards",
    ui: "package-tests",
    cli: "package-tests",
    "aws-cdk": "package-tests",
    upgrade: "upgrade-from-previous-release",
    codesearch: "codesearch",
    "codesearch-bun": "codesearch",
    vercel: "vercel-sandbox",
  }[lane]
}

// The job of these lanes sets lane variables that the manifest job does not
// set (GITHUB_TOKEN and VERCEL_TOKEN), so the key from the toolchain record
// does not describe the run of the check. Its hits are not accepted.
const runEnvDiffers = new Set(["vercel"])

const shadowJobs = new Set(["merge-gate-manifest", "merge-gate-select"])

export function decideMode({ config, event, fork, changed }) {
  const full = (reason) => ({ mode: "full", reason })
  if (event !== "pull_request") return full(`event ${event}`)
  if (fork) return full("fork PR")
  const inputs = changed.filter((path) =>
    gateInputs.some((input) => input.test(path)),
  )
  if (inputs.length)
    return full(
      `gate inputs changed: ${inputs.slice(0, 5).join(", ")}${inputs.length > 5 ? ` and ${inputs.length - 5} more` : ""}`,
    )
  if (!["shadow", "gate"].includes(config.mode))
    return full("selector unavailable: merge-gate.json has no valid mode")
  if (
    !/^[0-9a-f]{40}$/.test(config.factory?.version ?? "") ||
    !/^[0-9a-f]{64}$/.test(config.factory?.sha256 ?? "")
  )
    return full("selector unavailable: no pinned factory release")
  return { mode: "select", reason: config.mode }
}

// The result of each check id in the full run: its own record, else its job.
export function fullRunResults(records, needs) {
  const results = new Map()
  for (const record of records) {
    const kept = results.get(record.id)
    const bad = (status) => status === "failed" || status === "error"
    if (!kept || (bad(record.status) && !bad(kept)))
      results.set(record.id, record.status)
  }
  return (id) => {
    if (results.has(id)) return results.get(id)
    const job = needs[jobOf(id)]?.result
    return job === "success" ? "passed" : "unknown"
  }
}

// The verdict of today's full run: every job of the run succeeded.
export function fullVerdict(needs) {
  const failed = Object.entries(needs)
    .filter(([name]) => !shadowJobs.has(name))
    .filter(([, job]) => job.result === "failure" || job.result === "cancelled")
    .map(([name]) => name)
  return { verdict: failed.length ? "fail" : "pass", failed }
}

// What a gated run would decide on the same results. Each selected check needs
// one accepted result: an accepted hit, or its result in the full run (the
// gated run would run it).
export function gatedVerdict({ selection, config, result, needs }) {
  const hits = new Map(
    (selection.cache?.hits ?? []).map((hit) => [hit.id, hit]),
  )
  const accepted = (hit, lane) =>
    hit.source === "ci" ||
    hit.source === "local" ||
    (hit.source === "agent" &&
      config.acceptAgentResults === true &&
      !runEnvDiffers.has(lane))
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
  const failedAlwaysRun = alwaysRun.filter((job) =>
    ["failure", "cancelled"].includes(needs[job]?.result),
  )
  const bad = ran.filter((item) => ["failed", "error"].includes(item.result))
  const verdict =
    bad.length || failedAlwaysRun.length
      ? "fail"
      : ran.some((item) => item.result === "unknown")
        ? "unknown"
        : "pass"
  return { verdict, ran, hits: hit, failedAlwaysRun }
}

// The failed checks of the full run that the gated run would not run, and why.
export function escapes({ selection, records, gated }) {
  const ran = new Set(gated.ran.map((item) => item.id))
  const hits = new Map(gated.hits.map((item) => [item.id, item]))
  const omitted = new Map(selection.omitted.map((item) => [item.id, item]))
  const failed = [
    ...new Set(
      records
        .filter((record) => record.status === "failed")
        .map((record) => record.id),
    ),
  ].sort()
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

const round = (value) => Math.round(value * 10) / 10

// Runner minutes and wall time: the full run as measured, and the gated run
// as estimated from the selection, the shards and the measured setup times.
// The always-run jobs start with the manifest job; the profile jobs start
// after the select job.
export function cost({ ranIds, seconds, jobs }) {
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
  const always = sum(alwaysRunJob) + ciScriptTestMinutes
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

export function shadow({ config, inputs, records, needs, jobs, run }) {
  const mode = readJson(join(inputs, "mode.json"))
  const selection = readJson(join(inputs, "selection.json"))
  const select = needs["merge-gate-select"]?.result
  const full = fullVerdict(needs)
  const result = fullRunResults(records, needs)
  let fallback
  if (!mode)
    fallback = `manifest job ${needs["merge-gate-manifest"]?.result ?? "did not run"}`
  else if (mode.mode !== "select") fallback = mode.reason
  else if (select !== "success" || !selection)
    fallback = `selector unavailable: select job ${select ?? "did not run"}`
  else {
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
  const gated = gatedVerdict({ selection, config, result, needs })
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
  const recall = escapes({ selection, records, gated })
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
      agreement:
        full.verdict === "fail"
          ? gated.verdict === "fail"
            ? "agree"
            : gated.verdict === "pass"
              ? "escape"
              : "unknown"
          : "not a failing run",
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

const limit = 300

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
    }). Agreement: ${m.agreement}. Failed checks of the full run that the gated run would run: ${m.recall.ran} of ${m.recall.failed}. Hit contradictions: ${m.contradictions.length}.`,
    "",
    `**Runner minutes:** gated about ${m.cost.gatedRunMinutes} (manifest and select ${m.cost.parts.manifestAndSelect}, always-run ${m.cost.parts.alwaysRun}, checks ${m.cost.parts.profiles}); full run ${m.cost.fullRunMinutes}. **Wall time:** gated about ${m.cost.gatedRunWallMinutes} min; full run ${m.cost.fullRunWallMinutes ?? "?"} min.`,
  )
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
