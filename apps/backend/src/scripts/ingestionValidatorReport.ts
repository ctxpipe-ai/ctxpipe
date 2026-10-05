/**
 * Pure checks and rendering for the ingestion validator: turns the facts
 * collected for one repository (native run trees, repository row, extraction
 * write job, projection, units, size bounds, quality, spend) into checks with
 * a status, stage timings, and a JSON + Markdown report.
 */
import { z } from "zod"
import type { WorkspaceGraphQuality } from "../domain/workspaces/workspace-graph.js"
import type { ExtractWriteJob } from "../models/repository-knowledge-units.js"
import type {
  RepositoryStatus,
  ValidatorRun,
  ValidatorStep,
} from "./ingestionValidatorQueries.js"
import type { RepositoryLlm } from "./ingestionValidatorTelemetry.js"
import type { RepoGraphSizeRow } from "./repoGraphSizeCheck.js"

export const validatorModeSchema = z.enum(["index-only", "full"])
export type ValidatorMode = z.infer<typeof validatorModeSchema>

export const qualityThresholdsSchema = z
  .object({
    minJoinDensity: z.number().min(0).max(1).optional(),
    maxOrphanRate: z.number().min(0).max(1).optional(),
    minSourcedClaimRate: z.number().min(0).max(1).optional(),
  })
  .strict()
export type QualityThresholds = z.infer<typeof qualityThresholdsSchema>

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

export type ZoektProbe =
  | { ok: true; files: number }
  | { ok: false; error: string }

export type RepoUnitFacts = {
  kinds: Record<string, number>
  units: number
  withoutEmbedding: number
  presentPaths: string[]
}

export type RepoFacts = {
  repo: RepoSpec
  mode: ValidatorMode
  /** The validator run id, stamped as `request.id` on every enqueue. */
  requestId: string
  /** Full mode: the only allowed extraction destination. */
  workspaceId: string | null
  repositoryId: string | null
  enqueuedAt: string
  /** When the validator stopped waiting. */
  finishedAt: string
  timedOut: boolean
  /** Failure before or outside the pipeline (guard, link, enqueue, lookups). */
  error: string | null
  /** In-flight ingestion the validator waited for before enqueueing its own. */
  waitedFor: string | null
  /** Set when the enqueue returned a run without the validator's request id. */
  coalescedInto: string | null
  /** Orchestrator runs with the validator's request id: its own, then follow-ups. */
  ingestionRunIds: string[]
  /** Hydrate admitted by the final ingestion's extraction. */
  hydrateRunId: string | null
  runs: ValidatorRun[]
  steps: ValidatorStep[]
  repository: RepositoryStatus | null
  zoekt: ZoektProbe | null
  extractJob: ExtractWriteJob | null
  projection: ProjectionFacts | null
  repositoryUnits: RepoUnitFacts | null
  workspaceUnits: number | null
  size: { facts: Record<string, number>; rows: RepoGraphSizeRow[] } | null
  /** Quality of this repository's units only; thresholds apply here. */
  quality: WorkspaceGraphQuality | null
  /** Whole-Workspace quality at the same SHA (cumulative across repositories). */
  workspaceQuality: WorkspaceGraphQuality | null
  qualityThresholds: QualityThresholds | null
  llm: RepositoryLlm | null
  /** OpenRouter key usage delta across this repository; null when not measurable. */
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
  workspaceQuality: WorkspaceGraphQuality | null
  llm: RepositoryLlm | null
  spendUsd: number | null
  links: Record<string, string>
  enqueuedAt: string
  finishedAt: string
}

const SUCCEEDED = new Set(["completed", "succeeded"])

export function isTerminalRunStatus(status: string): boolean {
  return ["completed", "succeeded", "failed", "canceled"].includes(status)
}

export function runNamed(
  runs: readonly ValidatorRun[],
  workflow: string,
): ValidatorRun | undefined {
  return runs.find((run) => run.workflowName === workflow)
}

/** Runs of the final ingestion (the last follow-up, else the validator's own) and its hydrate. */
export function finalRuns(
  facts: Pick<RepoFacts, "runs" | "ingestionRunIds" | "hydrateRunId">,
): ValidatorRun[] {
  const root = facts.ingestionRunIds.at(-1)
  return facts.runs.filter(
    (run) => run.rootRunId === root || run.id === facts.hydrateRunId,
  )
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

function wall(steps: readonly ValidatorStep[]): number | null {
  const starts = steps.flatMap((s) => (s.startedAt ? [s.startedAt] : []))
  const ends = steps.flatMap((s) => (s.finishedAt ? [s.finishedAt] : []))
  return starts.length && ends.length
    ? Math.max(...ends.map(Date.parse)) - Math.min(...starts.map(Date.parse))
    : null
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
    return {
      workflow,
      step,
      attempts: attempts.length,
      failedAttempts: attempts.filter((a) => a.status === "failed").length,
      wallMs: wall(attempts),
    }
  })
}

/** Wall time per pipeline stage of the final ingestion; total spans every attributed run. */
export function stageDurations(
  facts: Pick<RepoFacts, "runs" | "steps" | "ingestionRunIds" | "hydrateRunId">,
): Record<string, number | null> {
  const runs = finalRuns(facts)
  const run = (name: string) => {
    const found = runNamed(runs, name)
    return found ? durationMs(found.startedAt, found.finishedAt) : null
  }
  const ingestion = runNamed(runs, "repository-ingestion")
  const first = facts.runs.find((r) => r.id === facts.ingestionRunIds[0])
  const ends = facts.runs.flatMap((r) =>
    (facts.ingestionRunIds.includes(r.rootRunId) ||
      r.id === facts.hydrateRunId) &&
    r.finishedAt
      ? [r.finishedAt]
      : [],
  )
  return {
    total:
      first && ends.length
        ? Math.max(...ends.map(Date.parse)) - Date.parse(first.createdAt)
        : null,
    codesearch: run("repository-index"),
    extraction: wall(
      facts.steps.filter(
        (step) =>
          step.runId === ingestion?.id &&
          ["identify-roots", "extract-kind", "identify"].includes(
            stepGroup(step.stepName),
          ),
      ),
    ),
    write: run("workspace-write-extract-ingest"),
    hydrate: run("workspace-hydrate"),
  }
}

function check(id: string, status: CheckStatus, detail: string): Check {
  return { id, status, detail }
}

function ingestionChecks(facts: RepoFacts): Check[] {
  const roots = facts.ingestionRunIds.map((id) =>
    facts.runs.find((run) => run.id === id),
  )
  const checks: Check[] = [
    facts.coalescedInto
      ? check(
          "ingestion.attribution",
          "fail",
          `enqueue returned ${facts.coalescedInto}, an ingestion without the validator's request id`,
        )
      : check(
          "ingestion.attribution",
          "pass",
          facts.waitedFor
            ? `waited for in-flight ingestion ${facts.waitedFor}, then enqueued its own`
            : "the validator's own full re-ingest",
        ),
  ]
  const problems = roots.flatMap((root, index) => {
    const label = index === 0 ? "ingestion" : `follow-up ${index}`
    if (!root) return [`${label}: run missing`]
    if (!isTerminalRunStatus(root.status))
      return [
        `${label}: ${facts.timedOut ? "timed out while " : ""}${root.status}`,
      ]
    if (!SUCCEEDED.has(root.status))
      return [`${label}: ${root.status}: ${errorMessage(root.error)}`]
    const aborted = record(root.output).aborted
    return aborted ? [`${label}: aborted: ${String(aborted)}`] : []
  })
  checks.push(
    roots.length === 0
      ? check("ingestion.workflow", "fail", "no orchestrator run")
      : problems.length
        ? check("ingestion.workflow", "fail", problems.join("; "))
        : check(
            "ingestion.workflow",
            "pass",
            roots.length > 1
              ? `completed, with ${roots.length - 1} tip-ahead follow-up(s); later checks read the last`
              : "completed",
          ),
  )
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
  const index = runNamed(finalRuns(facts), "repository-index")
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
    const last = indexSteps
      .filter(
        (step) =>
          stepGroup(step.stepName) === `scip:${lang}` &&
          SUCCEEDED.has(step.status),
      )
      .at(-1)
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

/** The commit SHA the final ingestion's extraction published, when it did. */
function extractionCommit(facts: RepoFacts): string | null {
  const output = record(
    runNamed(finalRuns(facts), "workspace-write-extract-ingest")?.output,
  )
  return output.committed === true && typeof output.commitSha === "string"
    ? output.commitSha
    : null
}

function extractionChecks(facts: RepoFacts): Check[] {
  if (facts.mode === "index-only")
    return [check("extraction", "skip", "index-only mode")]
  const extract = runNamed(finalRuns(facts), "workspace-write-extract-ingest")
  if (!extract)
    return [
      check(
        "extraction.commit",
        "fail",
        "no extraction ran (repository not linked to the Workspace?)",
      ),
    ]
  const checks: Check[] = [
    extract.workspaceId === facts.workspaceId
      ? check("extraction.destination", "pass", `${extract.workspaceId}`)
      : check(
          "extraction.destination",
          "fail",
          `extraction captured ${extract.workspaceId}, expected ${facts.workspaceId}`,
        ),
  ]
  const sha = extractionCommit(facts)
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
        `no commit: ${String(record(extract.output).reason ?? "not committed")}`,
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
  else
    checks.push(
      check(
        "extraction.commit",
        merged ? "warn" : "pass",
        `${sha}${merged ? " through semantic merge" : ""}; the write job records one commit (Workspace git history not inspected)`,
      ),
    )

  const paths = [
    ...new Set(Object.values(facts.extractJob?.knowledgePaths ?? {})),
  ]
  const hydrate = facts.runs.find((run) => run.id === facts.hydrateRunId)
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
  const hydrate = facts.runs.find((run) => run.id === facts.hydrateRunId)
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
    checks.push(check("hydrate.projection", "pass", `activated ${sha}`))
  else
    checks.push(
      check(
        "hydrate.projection",
        "fail",
        `not activated: ${String(output.reason ?? "unknown")}`,
      ),
    )

  // The stores and units below are read from the published projection, so
  // they describe this extraction only when that projection is at its SHA.
  const published = facts.projection?.sha ?? null
  if (!sha || published !== sha) {
    const detail = `published projection is at ${published ?? "nothing"}, extraction committed ${sha ?? "nothing"}`
    for (const id of ["hydrate.units", "hydrate.graph", "hydrate.embeddings"])
      checks.push(check(id, "fail", detail))
    return checks
  }
  const repoUnits = facts.repositoryUnits?.units ?? 0
  checks.push(
    check(
      "hydrate.units",
      (facts.workspaceUnits ?? 0) > 0 && repoUnits > 0 ? "pass" : "fail",
      `${repoUnits} repository units, ${facts.workspaceUnits ?? 0} in the Workspace at ${sha}`,
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

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
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
    return checks
  }
  const summary = `repository units: join ${pct(quality.joinDensity)}, orphans ${pct(quality.orphanRate)}, sourced ${pct(quality.sourcedClaimRate)}`
  if (!thresholds) {
    checks.push(
      check("quality.graph", "skip", `${summary} (no thresholds set)`),
    )
    return checks
  }
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
  return checks
}

/** Chat models other than GPT-6 Luna; embedding models are expected. */
export function unexpectedModels(models: Record<string, number>): string[] {
  return Object.keys(models).filter(
    (name) => !name.includes("gpt-6-luna") && !name.includes("embedding"),
  )
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
  if (facts.mode === "index-only") return checks
  if (!facts.llm) {
    checks.push(check("telemetry.llm", "warn", "Langfuse usage not measured"))
    return checks
  }
  const unpriced = facts.llm.unpricedModels
  checks.push(
    check(
      "telemetry.llm",
      unpriced.length ? "warn" : "pass",
      `${facts.llm.total.totalTokens} tokens, $${facts.llm.total.costUsd.toFixed(4)} in Langfuse (unverified query shape)${unpriced.length ? `; no price for ${unpriced.join(", ")}, so its cost reads $0` : ""}`,
    ),
  )
  const other = unexpectedModels(facts.llm.models)
  checks.push(
    other.length
      ? check("telemetry.models", "warn", `not GPT-6 Luna: ${other.join(", ")}`)
      : check(
          "telemetry.models",
          Object.keys(facts.llm.models).length ? "pass" : "warn",
          Object.keys(facts.llm.models).join(", ") || "no model names recorded",
        ),
  )
  return checks
}

export function evaluateRepo(
  facts: RepoFacts,
  links: Record<string, string> = {},
): RepoReport {
  const checks: Check[] = facts.error
    ? [check("validator", "fail", facts.error)]
    : []
  if (facts.ingestionRunIds.length || !facts.error)
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
    workspaceQuality: facts.workspaceQuality,
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
  /** Tier names the validator process was configured with (the worker should match). */
  configuredModels: Record<string, string | null>
  /** OpenRouter key usage over the run: per-repository deltas summed at concurrency 1. */
  spend: { totalUsd: number | null; limitUsd: number | null }
  links: Record<string, string>
  repos: RepoReport[]
}

function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${Math.round(ms / 1000)}s`
}

export function renderMarkdown(report: ValidatorReport): string {
  const spent =
    report.spend.totalUsd === null
      ? "not measured"
      : `$${report.spend.totalUsd.toFixed(4)}`
  const used: Record<string, number> = {}
  for (const repo of report.repos)
    for (const [name, calls] of Object.entries(repo.llm?.models ?? {}))
      used[name] = (used[name] ?? 0) + calls
  const mark = { pass: "ok", warn: "WARN", fail: "FAIL", skip: "skip" }
  const lines = [
    `# Ingestion validator ${report.runId}`,
    "",
    `Environment \`${report.environment}\`, mode \`${report.mode}\`, concurrency ${report.concurrency}, timeout ${report.timeoutMinutes} min. ${report.startedAt} → ${report.finishedAt}.`,
    "",
    `Models used (Langfuse generations): ${
      Object.entries(used)
        .map(([name, calls]) => `\`${name}\` ×${calls}`)
        .join(", ") || "none recorded"
    }. Configured tiers: ${Object.entries(report.configuredModels)
      .map(([tier, name]) => `${tier} \`${name ?? "default"}\``)
      .join(", ")}.`,
    "",
    `OpenRouter spend: ${spent}${report.spend.limitUsd !== null ? ` (key limit $${report.spend.limitUsd})` : ""}. ${
      report.concurrency > 1
        ? `Per-repository OpenRouter deltas are unavailable at concurrency ${report.concurrency}; use the per-stage Langfuse cost.`
        : "Per-repository spend is the key's usage delta across that repository."
    } Langfuse token and cost figures use an unverified query shape until a paid run confirms it; the commit-subject call is not traced and shows only in the OpenRouter delta.`,
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
          `| ${c.id} | ${mark[c.status]} | ${c.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
      ),
    )
    if (repo.llm) {
      const stages: Array<[string, (typeof repo.llm.stages)[string]]> = [
        ...Object.entries(repo.llm.stages),
        ["total (Langfuse)", repo.llm.total],
      ]
      lines.push(
        "",
        "| LLM stage | Calls | Input | Output | Cost |",
        "| --- | --- | --- | --- | --- |",
        ...stages.map(
          ([stage, usage]) =>
            `| ${stage} | ${usage.calls} | ${usage.inputTokens} | ${usage.outputTokens} | $${usage.costUsd.toFixed(4)} |`,
        ),
      )
      if (repo.spendUsd !== null)
        lines.push(
          `| not in Langfuse (OpenRouter delta − Langfuse total) | — | — | — | $${(repo.spendUsd - repo.llm.total.costUsd).toFixed(4)} |`,
        )
    }
    if (repo.workspaceQuality)
      lines.push(
        "",
        `Workspace at this SHA (cumulative across repositories, no thresholds): ${repo.workspaceQuality.totalUnits} units, join ${pct(repo.workspaceQuality.joinDensity)}, orphans ${pct(repo.workspaceQuality.orphanRate)}, sourced ${pct(repo.workspaceQuality.sourcedClaimRate)}.`,
      )
    lines.push(
      "",
      `Runs: ${repo.runs
        .map(
          (run) =>
            `${run.workflow} \`${run.id}\` ${run.status}${run.traceId ? ` trace \`${run.traceId}\`` : ""}`,
        )
        .join("; ")}`,
      ...Object.entries(repo.links).map(([name, url]) => `- ${name}: ${url}`),
    )
  }
  return `${lines.join("\n")}\n`
}
