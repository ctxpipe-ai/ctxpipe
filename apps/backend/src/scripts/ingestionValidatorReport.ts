/**
 * Pure checks and rendering for the ingestion validator: turns the facts
 * collected for one repository (native run tree, repository row, extraction
 * write job, projection, units, size bounds, quality, spend) into checks with
 * a status, stage timings, and a JSON + Markdown report.
 */
import type { WorkspaceGraphQuality } from "../domain/workspaces/workspace-graph.js"
import type {
  ExtractWriteJob,
  RepositoryStatus,
  RepositoryUnits,
  ValidatorRun,
  ValidatorStep,
} from "./ingestionValidatorQueries.js"
import type { LlmUsage } from "./ingestionValidatorTelemetry.js"
import type { RepoGraphSizeRow } from "./repoGraphSizeCheck.js"

export type ValidatorMode = "full" | "index-only"

export type RepoSpec = {
  /** As written in the repos file: `owner/name` or a git URL. */
  name: string
  gitUrl: string
  /** SCIP languages that must be detected and indexed. */
  expectedLanguages: string[]
}

/** One line per repository: `owner/name|url [lang,lang]`; `#` starts a comment. */
export function parseReposFile(text: string): RepoSpec[] {
  return text.split("\n").flatMap((raw) => {
    const line = raw.replace(/#.*/, "").trim()
    if (!line) return []
    const [name = "", languages = ""] = line.split(/\s+/)
    const gitUrl = /^[\w.-]+\/[\w.-]+$/.test(name)
      ? `https://github.com/${name}`
      : name
    if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+/.test(gitUrl))
      throw new Error(`Not a repository: ${line}`)
    return [
      {
        name,
        gitUrl,
        expectedLanguages: languages
          .split(",")
          .map((lang) => lang.trim().toLowerCase())
          .filter(Boolean),
      },
    ]
  })
}

export type ProjectionFacts = {
  kind: string
  sha: string | null
  graph: string
  embeddings: string
}

export type QualityThresholds = {
  minJoinDensity?: number
  maxOrphanRate?: number
  minSourcedClaimRate?: number
}

export type ZoektProbe =
  | { ok: true; files: number }
  | { ok: false; error: string }

export type RepoFacts = {
  repo: RepoSpec
  mode: ValidatorMode
  repositoryId: string | null
  enqueuedAt: string
  /** When the validator stopped waiting. */
  finishedAt: string
  timedOut: boolean
  /** Failure before or outside the pipeline (link, enqueue, lookups). */
  error: string | null
  orchestratorRunId: string | null
  runs: ValidatorRun[]
  steps: ValidatorStep[]
  repository: RepositoryStatus | null
  zoekt: ZoektProbe | null
  extractJob: ExtractWriteJob | null
  projection: ProjectionFacts | null
  repositoryUnits: RepositoryUnits | null
  workspaceUnits: number | null
  size: { facts: Record<string, number>; rows: RepoGraphSizeRow[] } | null
  quality: WorkspaceGraphQuality | null
  qualityThresholds: QualityThresholds | null
  llm: { stages: Record<string, LlmUsage>; total: LlmUsage } | null
  /** OpenRouter key usage delta across this repository; null when not measured. */
  spendUsd: number | null
}

export type CheckStatus = "pass" | "warn" | "fail" | "skip"

export type Check = {
  id: string
  status: CheckStatus
  detail: string
}

export type StepTiming = {
  workflow: string
  step: string
  attempts: number
  failedAttempts: number
  /** First attempt start to last attempt finish. */
  wallMs: number | null
}

export type RepoStatus = "PASS" | "WARN" | "FAIL" | "TIMEOUT"

export type RepoReport = {
  name: string
  gitUrl: string
  repositoryId: string | null
  status: RepoStatus
  checks: Check[]
  stages: Record<string, number | null>
  steps: StepTiming[]
  runs: Array<{
    id: string
    workflow: string
    status: string
    traceId: string | null
  }>
  extractionCommitSha: string | null
  projectionSha: string | null
  size: RepoFacts["size"]
  quality: WorkspaceGraphQuality | null
  llm: RepoFacts["llm"]
  spendUsd: number | null
  links: Record<string, string>
  enqueuedAt: string
  finishedAt: string
}

const TERMINAL = new Set(["completed", "succeeded", "failed", "canceled"])
const SUCCEEDED = new Set(["completed", "succeeded"])

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Codesearch phases checkpoint `{ admitted, value }` (index admission retry). */
function admittedValue(output: unknown): Record<string, unknown> {
  const outer = record(output)
  return "admitted" in outer ? record(outer.value) : outer
}

function errorMessage(error: unknown): string {
  const message = record(error).message
  return typeof message === "string" ? message : JSON.stringify(error)
}

/** `zoekt:admit-2` → `zoekt`; `extract-kind:<root>` → `extract-kind`; `scip:go` stays. */
export function stepGroup(stepName: string): string {
  const name = stepName.replace(/:admit(?:-wait)?-\d+$/, "")
  if (name.startsWith("scip:")) return name
  const colon = name.indexOf(":")
  return colon > 0 ? name.slice(0, colon) : name
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  return Date.parse(end) - Date.parse(start)
}

export function stepTimings(
  runs: ValidatorRun[],
  steps: ValidatorStep[],
): StepTiming[] {
  const workflowByRun = new Map(runs.map((run) => [run.id, run.workflowName]))
  const groups = new Map<string, ValidatorStep[]>()
  for (const step of steps) {
    if (step.kind === "sleep") continue
    const key = `${workflowByRun.get(step.runId) ?? "?"}\u0000${stepGroup(step.stepName)}`
    groups.set(key, [...(groups.get(key) ?? []), step])
  }
  return [...groups].map(([key, attempts]) => {
    const [workflow = "?", step = "?"] = key.split("\u0000")
    const starts = attempts.flatMap((a) => (a.startedAt ? [a.startedAt] : []))
    const ends = attempts.flatMap((a) => (a.finishedAt ? [a.finishedAt] : []))
    return {
      workflow,
      step,
      attempts: attempts.length,
      failedAttempts: attempts.filter((a) => a.status === "failed").length,
      wallMs:
        starts.length && ends.length
          ? Math.max(...ends.map(Date.parse)) -
            Math.min(...starts.map(Date.parse))
          : null,
    }
  })
}

function runNamed(runs: ValidatorRun[], workflow: string) {
  return runs.find((run) => run.workflowName === workflow)
}

/** Wall time per pipeline stage, from native run and step timestamps. */
export function stageDurations(
  facts: Pick<RepoFacts, "runs" | "steps">,
): Record<string, number | null> {
  const run = (name: string) => {
    const found = runNamed(facts.runs, name)
    return found ? durationMs(found.startedAt, found.finishedAt) : null
  }
  const ingestion = runNamed(facts.runs, "repository-ingestion")
  const extraction = facts.steps.filter(
    (step) =>
      step.runId === ingestion?.id &&
      ["identify-roots", "extract-kind", "identify"].includes(
        stepGroup(step.stepName),
      ),
  )
  const starts = extraction.flatMap((s) => (s.startedAt ? [s.startedAt] : []))
  const ends = extraction.flatMap((s) => (s.finishedAt ? [s.finishedAt] : []))
  const orchestrator = runNamed(facts.runs, "repository-ingestion-orchestrator")
  const hydrate = runNamed(facts.runs, "workspace-hydrate")
  return {
    total: orchestrator
      ? durationMs(
          orchestrator.createdAt,
          hydrate?.finishedAt ?? orchestrator.finishedAt,
        )
      : null,
    codesearch: run("repository-index"),
    extraction:
      starts.length && ends.length
        ? Math.max(...ends.map(Date.parse)) -
          Math.min(...starts.map(Date.parse))
        : null,
    write: run("workspace-write-extract-ingest"),
    hydrate: run("workspace-hydrate"),
  }
}

function check(id: string, status: CheckStatus, detail: string): Check {
  return { id, status, detail }
}

function ingestionChecks(facts: RepoFacts): Check[] {
  const root = facts.runs.find((run) => run.id === facts.orchestratorRunId)
  const checks: Check[] = []
  if (!root) {
    checks.push(check("ingestion.workflow", "fail", "no orchestrator run"))
  } else if (facts.timedOut && !isTerminalRunStatus(root.status)) {
    checks.push(
      check("ingestion.workflow", "fail", `timed out while ${root.status}`),
    )
  } else if (!SUCCEEDED.has(root.status)) {
    checks.push(
      check(
        "ingestion.workflow",
        "fail",
        `${root.status}: ${errorMessage(root.error)}`,
      ),
    )
  } else if (record(root.output).aborted) {
    checks.push(
      check(
        "ingestion.workflow",
        "fail",
        `aborted: ${String(record(root.output).aborted)}`,
      ),
    )
  } else {
    checks.push(check("ingestion.workflow", "pass", root.status))
  }
  const status = facts.repository?.indexingStatus ?? "missing"
  checks.push(
    status === "ready"
      ? check("ingestion.repository_status", "pass", "ready")
      : status === "complete_with_issues"
        ? check(
            "ingestion.repository_status",
            "warn",
            `complete_with_issues: ${facts.repository?.indexingError ?? ""}`,
          )
        : check(
            "ingestion.repository_status",
            "fail",
            `${status}${facts.repository?.indexingError ? `: ${facts.repository.indexingError}` : ""}`,
          ),
  )
  return checks
}

function codesearchChecks(facts: RepoFacts): Check[] {
  const index = runNamed(facts.runs, "repository-index")
  if (!index || !SUCCEEDED.has(index.status))
    return [
      check(
        "codesearch.zoekt",
        "fail",
        index ? `repository-index ${index.status}` : "no repository-index run",
      ),
      check("codesearch.scip", "fail", "no completed index"),
    ]
  const output = record(index.output)
  const checks: Check[] = []
  if (output.searchIndexOk === false)
    checks.push(
      check(
        "codesearch.zoekt",
        "fail",
        String(output.searchIndexError ?? "search index failed"),
      ),
    )
  else if (facts.zoekt?.ok === false)
    checks.push(
      check("codesearch.zoekt", "fail", `search probe: ${facts.zoekt.error}`),
    )
  else if (facts.zoekt?.ok && facts.zoekt.files === 0)
    checks.push(
      check("codesearch.zoekt", "fail", "search probe matched no files"),
    )
  else
    checks.push(
      check(
        "codesearch.zoekt",
        "pass",
        facts.zoekt?.ok
          ? `shards searchable (${facts.zoekt.files} files matched)`
          : "indexed (search probe not run)",
      ),
    )

  const indexSteps = facts.steps.filter((step) => step.runId === index.id)
  const detected = indexSteps
    .filter(
      (step) =>
        stepGroup(step.stepName) === "detect-languages" &&
        SUCCEEDED.has(step.status),
    )
    .map((step) => admittedValue(step.output))
    .find((value) => Array.isArray(value.detectedLanguages))
  if (!detected) {
    checks.push(
      check(
        "codesearch.scip",
        output.scipIndexOk === false ? "fail" : "warn",
        output.scipIndexOk === false
          ? String(output.scipIndexError ?? "SCIP failed")
          : "index already published at this SHA; no per-language results",
      ),
    )
    return checks
  }
  const detectedLanguages = (
    (detected.detectedLanguages as string[] | undefined) ?? []
  ).map((lang) => lang.toLowerCase())
  const toIndex = (detected.languagesToIndex as string[] | undefined) ?? []
  const problems: string[] = []
  const missing = facts.repo.expectedLanguages.filter(
    (lang) => !detectedLanguages.includes(lang),
  )
  if (missing.length) problems.push(`not detected: ${missing.join(", ")}`)
  for (const lang of toIndex) {
    const attempts = indexSteps.filter(
      (step) => stepGroup(step.stepName) === `scip:${lang}`,
    )
    const last = attempts.filter((step) => SUCCEEDED.has(step.status)).at(-1)
    const value = last ? admittedValue(last.output) : null
    if (!value) problems.push(`${lang}: no completed attempt`)
    else if (value.ok === false)
      problems.push(`${lang}: ${String(value.error ?? "failed")}`)
  }
  const merge = indexSteps
    .filter(
      (step) =>
        stepGroup(step.stepName) === "merge-scip" && SUCCEEDED.has(step.status),
    )
    .map((step) => admittedValue(step.output))
    .at(-1)
  if (merge?.ok === false)
    problems.push(`merge: ${String(merge.error ?? "failed")}`)
  else if (detectedLanguages.length && merge?.shardCount === 0)
    problems.push("merge: zero valid shards")
  checks.push(
    problems.length
      ? check("codesearch.scip", "fail", problems.join("; "))
      : check(
          "codesearch.scip",
          "pass",
          `indexed ${toIndex.join(", ") || "none"} (detected ${detectedLanguages.join(", ") || "none"})`,
        ),
  )
  return checks
}

/** The commit SHA the extraction published, when it did. */
function extractionCommit(facts: RepoFacts): string | null {
  const extract = runNamed(facts.runs, "workspace-write-extract-ingest")
  const output = record(extract?.output)
  return output.committed === true && typeof output.commitSha === "string"
    ? output.commitSha
    : null
}

function extractionChecks(facts: RepoFacts): Check[] {
  const extract = runNamed(facts.runs, "workspace-write-extract-ingest")
  if (facts.mode === "index-only")
    return [
      extract
        ? check(
            "extraction.commit",
            "fail",
            "an extraction ran in index-only mode (the org has an extraction destination)",
          )
        : check(
            "extraction.commit",
            "skip",
            "index-only: no extraction destination",
          ),
    ]
  if (!extract)
    return [
      check(
        "extraction.commit",
        "fail",
        "no extraction ran (repository not linked to the Workspace?)",
      ),
      check("extraction.knowledge_files", "fail", "no extraction"),
    ]
  const checks: Check[] = []
  const output = record(extract.output)
  const sha = extractionCommit(facts)
  const commits = facts.steps.filter(
    (step) =>
      step.runId === extract.id &&
      step.stepName === "commit" &&
      SUCCEEDED.has(step.status),
  ).length
  const merged = facts.runs.some(
    (run) =>
      run.workflowName === "workspace-semantic-merge" &&
      run.parentRunId === extract.id,
  )
  if (!SUCCEEDED.has(extract.status))
    checks.push(
      check(
        "extraction.commit",
        "fail",
        `${extract.status}: ${errorMessage(extract.error)}`,
      ),
    )
  else if (!sha)
    checks.push(
      check(
        "extraction.commit",
        "fail",
        `no commit: ${String(output.reason ?? "not committed")}`,
      ),
    )
  else if (facts.extractJob?.commitSha !== sha)
    checks.push(
      check(
        "extraction.commit",
        "fail",
        `write job records ${facts.extractJob?.commitSha ?? "no commit"}, run published ${sha}`,
      ),
    )
  else if (commits !== 1)
    checks.push(
      check(
        "extraction.commit",
        "fail",
        `${commits} commit steps for one extraction`,
      ),
    )
  else
    checks.push(
      check(
        "extraction.commit",
        merged ? "warn" : "pass",
        merged ? `${sha} (published through semantic merge)` : sha,
      ),
    )

  const paths = [
    ...new Set(Object.values(facts.extractJob?.knowledgePaths ?? {})),
  ]
  const hydrate = runNamed(facts.runs, "workspace-hydrate")
  const diagnostics = (record(hydrate?.output).diagnostics ?? []) as Array<{
    path?: string
    reason?: string
  }>
  const malformed = diagnostics
    .filter((item) => item.path && paths.includes(item.path))
    .map((item) => `${item.path} (${item.reason ?? "skipped"})`)
  const present = new Set(facts.repositoryUnits?.presentPaths ?? [])
  const missing = paths.filter((path) => !present.has(path))
  checks.push(
    paths.length === 0
      ? check(
          "extraction.knowledge_files",
          "fail",
          "extraction recorded no knowledge paths",
        )
      : malformed.length || missing.length
        ? check(
            "extraction.knowledge_files",
            "fail",
            [
              malformed.length ? `malformed: ${malformed.join(", ")}` : "",
              missing.length
                ? `${missing.length} of ${paths.length} not projected (e.g. ${missing.slice(0, 3).join(", ")})`
                : "",
            ]
              .filter(Boolean)
              .join("; "),
          )
        : check(
            "extraction.knowledge_files",
            "pass",
            `${paths.length} knowledge files parse and project`,
          ),
  )
  return checks
}

function hydrateChecks(facts: RepoFacts): Check[] {
  if (facts.mode === "index-only") return []
  const sha = extractionCommit(facts)
  const hydrate = runNamed(facts.runs, "workspace-hydrate")
  const output = record(hydrate?.output)
  const checks: Check[] = []
  if (!sha) checks.push(check("hydrate.projection", "fail", "no commit"))
  else if (!hydrate)
    checks.push(
      check("hydrate.projection", "fail", "no hydrate run for the commit"),
    )
  else if (!SUCCEEDED.has(hydrate.status))
    checks.push(
      check(
        "hydrate.projection",
        "fail",
        `${hydrate.status}: ${errorMessage(hydrate.error)}`,
      ),
    )
  else if (hydrate.revisionSha !== sha)
    checks.push(
      check(
        "hydrate.projection",
        "fail",
        `hydrate projected ${hydrate.revisionSha}, extraction committed ${sha}`,
      ),
    )
  else if (output.hydrated === true)
    checks.push(check("hydrate.projection", "pass", `active at ${sha}`))
  else
    checks.push(
      check(
        "hydrate.projection",
        output.reason === "cas_discarded" ? "warn" : "fail",
        `not activated: ${String(output.reason ?? "unknown")}`,
      ),
    )

  const repoUnits = facts.repositoryUnits?.units ?? 0
  checks.push(
    (facts.workspaceUnits ?? 0) > 0 && repoUnits > 0
      ? check(
          "hydrate.units",
          "pass",
          `${repoUnits} repository units, ${facts.workspaceUnits} in the Workspace`,
        )
      : check(
          "hydrate.units",
          "fail",
          `${repoUnits} repository units, ${facts.workspaceUnits ?? 0} in the Workspace`,
        ),
  )
  const graph = facts.projection?.graph ?? "unknown"
  checks.push(
    check(
      "hydrate.graph",
      graph === "ready" ? "pass" : "fail",
      `graph ${graph}`,
    ),
  )
  const embeddings = facts.projection?.embeddings ?? "unknown"
  const unembedded = facts.repositoryUnits?.withoutEmbedding ?? 0
  checks.push(
    check(
      "hydrate.embeddings",
      embeddings === "ready" && unembedded === 0 ? "pass" : "fail",
      `embeddings ${embeddings}${unembedded ? `; ${unembedded} repository units without an embedding` : ""}`,
    ),
  )
  return checks
}

function qualityChecks(facts: RepoFacts): Check[] {
  if (facts.mode === "index-only") return []
  const checks: Check[] = []
  if (!facts.size) {
    checks.push(check("quality.size", "warn", "checkout paths unavailable"))
  } else {
    const low = facts.size.rows.filter((row) => row.ok === false)
    checks.push(
      low.length
        ? check(
            "quality.size",
            "fail",
            low
              .map((row) => `${row.name} ${row.actual} < ${row.expected}`)
              .join("; "),
          )
        : check(
            "quality.size",
            "pass",
            facts.size.rows
              .filter((row) => row.ok !== null)
              .map((row) => `${row.name} ${row.actual} ≥ ${row.expected}`)
              .join("; "),
          ),
    )
  }
  const quality = facts.quality
  const thresholds = facts.qualityThresholds
  if (!quality) {
    checks.push(check("quality.graph", "warn", "quality report unavailable"))
  } else {
    const summary = `join ${pct(quality.joinDensity)}, orphans ${pct(quality.orphanRate)}, sourced ${pct(quality.sourcedClaimRate)}`
    if (!thresholds) {
      checks.push(
        check("quality.graph", "skip", `${summary} (no thresholds set)`),
      )
    } else {
      const misses = [
        thresholds.minJoinDensity !== undefined &&
        quality.joinDensity < thresholds.minJoinDensity
          ? `join density < ${pct(thresholds.minJoinDensity)}`
          : "",
        thresholds.maxOrphanRate !== undefined &&
        quality.orphanRate > thresholds.maxOrphanRate
          ? `orphan rate > ${pct(thresholds.maxOrphanRate)}`
          : "",
        thresholds.minSourcedClaimRate !== undefined &&
        quality.sourcedClaimRate < thresholds.minSourcedClaimRate
          ? `sourced claims < ${pct(thresholds.minSourcedClaimRate)}`
          : "",
      ].filter(Boolean)
      checks.push(
        check(
          "quality.graph",
          misses.length ? "fail" : "pass",
          misses.length ? `${summary}: ${misses.join("; ")}` : summary,
        ),
      )
    }
  }
  return checks
}

function telemetryChecks(facts: RepoFacts): Check[] {
  const traced = facts.runs.filter((run) => run.traceId).length
  const checks = [
    traced > 0
      ? check(
          "telemetry.traces",
          "pass",
          `${traced} of ${facts.runs.length} runs carry a trace id`,
        )
      : check("telemetry.traces", "warn", "no run carries a trace id"),
  ]
  const tokens = facts.llm?.total.totalTokens
  if (facts.mode === "index-only")
    checks.push(
      tokens
        ? check(
            "telemetry.llm",
            "fail",
            `${tokens} LLM tokens in index-only mode`,
          )
        : check(
            "telemetry.llm",
            "pass",
            facts.llm ? "no LLM generations" : "no extraction, no LLM calls",
          ),
    )
  else
    checks.push(
      facts.llm
        ? check(
            "telemetry.llm",
            "pass",
            `${facts.llm.total.totalTokens} tokens, $${facts.llm.total.costUsd.toFixed(4)} in Langfuse`,
          )
        : check("telemetry.llm", "warn", "Langfuse usage not measured"),
    )
  return checks
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function evaluateRepo(
  facts: RepoFacts,
  links: Record<string, string> = {},
): RepoReport {
  const checks: Check[] = facts.error
    ? [check("validator", "fail", facts.error)]
    : []
  if (facts.orchestratorRunId || !facts.error)
    checks.push(
      ...ingestionChecks(facts),
      ...codesearchChecks(facts),
      ...extractionChecks(facts),
      ...hydrateChecks(facts),
      ...qualityChecks(facts),
      ...telemetryChecks(facts),
    )
  const status: RepoStatus = facts.timedOut
    ? "TIMEOUT"
    : checks.some((c) => c.status === "fail")
      ? "FAIL"
      : checks.some((c) => c.status === "warn")
        ? "WARN"
        : "PASS"
  return {
    name: facts.repo.name,
    gitUrl: facts.repo.gitUrl,
    repositoryId: facts.repositoryId,
    status,
    checks,
    stages: stageDurations(facts),
    steps: stepTimings(facts.runs, facts.steps),
    runs: facts.runs.map((run) => ({
      id: run.id,
      workflow: run.workflowName,
      status: run.status,
      traceId: run.traceId,
    })),
    extractionCommitSha: extractionCommit(facts),
    projectionSha: facts.projection?.sha ?? null,
    size: facts.size,
    quality: facts.quality,
    llm: facts.llm,
    spendUsd: facts.spendUsd,
    links,
    enqueuedAt: facts.enqueuedAt,
    finishedAt: facts.finishedAt,
  }
}

export type ValidatorReport = {
  runId: string
  environment: string
  mode: ValidatorMode
  orgId: string
  workspaceId: string | null
  concurrency: number
  timeoutMinutes: number
  startedAt: string
  finishedAt: string
  /** Model tier names the validator process saw (the worker must match). */
  models: Record<string, string | null>
  spend: {
    beforeUsd: number | null
    afterUsd: number | null
    limitUsd: number | null
  }
  links: Record<string, string>
  repos: RepoReport[]
}

function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${Math.round(ms / 1000)}s`
}

const STATUS_MARK: Record<CheckStatus, string> = {
  pass: "ok",
  warn: "WARN",
  fail: "FAIL",
  skip: "skip",
}

export function renderMarkdown(report: ValidatorReport): string {
  const spent =
    report.spend.beforeUsd !== null && report.spend.afterUsd !== null
      ? `$${(report.spend.afterUsd - report.spend.beforeUsd).toFixed(4)}`
      : "not measured"
  const lines = [
    `# Ingestion validator ${report.runId}`,
    "",
    `Environment \`${report.environment}\`, mode \`${report.mode}\`, concurrency ${report.concurrency}, timeout ${report.timeoutMinutes} min. ${report.startedAt} → ${report.finishedAt}.`,
    "",
    `Models: ${Object.entries(report.models)
      .map(([tier, name]) => `${tier} \`${name ?? "default"}\``)
      .join(
        ", ",
      )}. OpenRouter spend: ${spent}${report.spend.limitUsd !== null ? ` (key limit $${report.spend.limitUsd})` : ""}.`,
    "",
    ...Object.entries(report.links).map(([name, url]) => `- ${name}: ${url}`),
    "",
    "| Repository | Status | Total | Codesearch | Extraction | Write | Hydrate | Tokens | Spend |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.repos.map(
      (repo) =>
        `| ${repo.name} | ${repo.status} | ${seconds(repo.stages.total)} | ${seconds(repo.stages.codesearch)} | ${seconds(repo.stages.extraction)} | ${seconds(repo.stages.write)} | ${seconds(repo.stages.hydrate)} | ${repo.llm ? repo.llm.total.totalTokens : "—"} | ${repo.spendUsd === null ? "—" : `$${repo.spendUsd.toFixed(4)}`} |`,
    ),
  ]
  for (const repo of report.repos) {
    lines.push(
      "",
      `## ${repo.name} — ${repo.status}`,
      "",
      `Repository \`${repo.repositoryId ?? "—"}\`, extraction commit \`${repo.extractionCommitSha ?? "—"}\`, projection \`${repo.projectionSha ?? "—"}\`.`,
      "",
      "| Check | Status | Detail |",
      "| --- | --- | --- |",
      ...repo.checks.map(
        (c) =>
          `| ${c.id} | ${STATUS_MARK[c.status]} | ${c.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
      ),
    )
    if (repo.llm) {
      lines.push(
        "",
        "| LLM stage | Calls | Input | Output | Cost |",
        "| --- | --- | --- | --- | --- |",
        ...Object.entries({ ...repo.llm.stages, total: repo.llm.total }).map(
          ([stage, usage]) =>
            `| ${stage} | ${usage.calls} | ${usage.inputTokens} | ${usage.outputTokens} | $${usage.costUsd.toFixed(4)} |`,
        ),
      )
    }
    lines.push(
      "",
      "Runs: " +
        repo.runs
          .map(
            (run) =>
              `${run.workflow} \`${run.id}\` ${run.status}${run.traceId ? ` trace \`${run.traceId}\`` : ""}`,
          )
          .join("; "),
      ...Object.entries(repo.links).map(([name, url]) => `- ${name}: ${url}`),
    )
  }
  return `${lines.join("\n")}\n`
}
