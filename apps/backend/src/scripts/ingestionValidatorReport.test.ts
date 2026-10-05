import { describe, expect, it } from "vitest"
import type {
  ValidatorRun,
  ValidatorStep,
} from "./ingestionValidatorQueries.js"
import {
  evaluateRepo,
  parseReposFile,
  type RepoFacts,
  renderMarkdown,
  stageDurations,
  stepGroup,
  stepTimings,
  unexpectedModels,
  type ValidatorReport,
} from "./ingestionValidatorReport.js"

const commit = "c".repeat(40)
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 3, 10, 0, seconds)).toISOString()
const quality = {
  totalUnits: 2,
  totalClaims: 6,
  multiSourceUnits: 1,
  joinDensity: 0.5,
  orphanUnits: 0,
  orphanRate: 0,
  sourcedClaimRate: 1,
  kinds: {},
  predicates: {},
}

function run(
  id: string,
  workflowName: string,
  extra: Partial<ValidatorRun> = {},
): ValidatorRun {
  return {
    id,
    rootRunId: "run_orch",
    workflowName,
    status: "completed",
    parentRunId: null,
    parentStepName: null,
    output: null,
    error: null,
    requestId: "val_1",
    workspaceId: null,
    revisionSha: null,
    traceId: null,
    createdAt: at(0),
    startedAt: at(1),
    finishedAt: at(100),
    ...extra,
  }
}

function step(
  runId: string,
  stepName: string,
  start: number,
  end: number,
  extra: Partial<ValidatorStep> = {},
): ValidatorStep {
  return {
    runId,
    stepName,
    kind: "function",
    status: "completed",
    startedAt: at(start),
    finishedAt: at(end),
    output: null,
    error: null,
    childRunId: null,
    ...extra,
  }
}

const usage = (calls: number, cost: number) => ({
  calls,
  inputTokens: calls * 1000,
  outputTokens: calls * 200,
  totalTokens: calls * 1200,
  costUsd: cost,
})

/** A full-mode ingestion where every stage succeeded. */
function passingFacts(): RepoFacts {
  return {
    repo: {
      name: "example/app",
      gitUrl: "https://github.com/example/app",
      expectedLanguages: ["typescript"],
    },
    mode: "full",
    requestId: "val_1",
    workspaceId: "ws_1",
    repositoryId: "repo_1",
    enqueuedAt: at(0),
    finishedAt: at(200),
    timedOut: false,
    error: null,
    waitedFor: null,
    coalescedInto: null,
    ingestionRunIds: ["run_orch"],
    hydrateRunId: "run_hydrate",
    runs: [
      run("run_orch", "repository-ingestion-orchestrator", {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        createdAt: at(0),
        finishedAt: at(120),
      }),
      run("run_ingest", "repository-ingestion", { parentRunId: "run_orch" }),
      run("run_index", "repository-index", {
        parentRunId: "run_ingest",
        startedAt: at(2),
        finishedAt: at(40),
        output: { searchIndexOk: true, scipIndexOk: true },
      }),
      run("run_extract", "workspace-write-extract-ingest", {
        parentRunId: "run_ingest",
        workspaceId: "ws_1",
        startedAt: at(90),
        finishedAt: at(110),
        output: { committed: true, commitSha: commit },
      }),
      run("run_hydrate", "workspace-hydrate", {
        rootRunId: "run_hydrate",
        workspaceId: "ws_1",
        startedAt: at(111),
        finishedAt: at(150),
        revisionSha: commit,
        output: { hydrated: true, units: 12, skipped: 0, diagnostics: [] },
      }),
    ],
    steps: [
      step("run_index", "detect-languages", 10, 12, {
        output: {
          admitted: true,
          value: {
            detectedLanguages: ["typescript"],
            languagesToIndex: ["typescript"],
          },
        },
      }),
      step("run_index", "scip:typescript", 12, 30, {
        status: "failed",
        error: { message: "busy" },
      }),
      step("run_index", "scip:typescript:admit-1", 31, 38, {
        output: { admitted: true, value: { ok: true } },
      }),
      step("run_index", "merge-scip", 38, 40, {
        output: { admitted: true, value: { ok: true, shardCount: 1 } },
      }),
      step("run_ingest", "identify-roots", 41, 50),
      step("run_ingest", "extract-kind:root-a", 50, 70),
      step("run_ingest", "identify:root-a", 70, 89),
      step("run_extract", "await-write-access", 101, 160, { kind: "sleep" }),
    ],
    repository: {
      indexingStatus: "ready",
      indexingError: null,
      lastIngestedHash: "a".repeat(40),
      indexReady: true,
    },
    zoekt: { ok: true, files: 1 },
    extractJob: {
      id: "wjob_run_ingest_extract",
      status: "completed",
      commitSha: commit,
      knowledgePaths: {
        "repo:svc": "services/app.md",
        "repo:decision": "decisions/use-ts.md",
      },
    },
    projection: {
      kind: "active",
      sha: commit,
      graph: "ready",
      embeddings: "ready",
    },
    repositoryUnits: {
      kinds: { Service: 1, Decision: 1 },
      units: 2,
      withoutEmbedding: 0,
      presentPaths: ["decisions/use-ts.md", "services/app.md"],
    },
    workspaceUnits: 12,
    size: {
      facts: { trackedFiles: 40 },
      rows: [
        { name: "Service+App+Library", expected: 1, actual: 1, ok: true },
        { name: "scipDocuments", expected: 20, actual: null, ok: null },
      ],
    },
    quality,
    workspaceQuality: { ...quality, totalUnits: 12, joinDensity: 0.2 },
    qualityThresholds: { minJoinDensity: 0.3, maxOrphanRate: 0.2 },
    llm: {
      stages: {
        "identify-roots": usage(1, 0.0002),
        embeddings: usage(1, 0.0001),
      },
      total: usage(2, 0.0003),
      models: { "openai/gpt-6-luna": 1, "openai/text-embedding-3-large": 1 },
      unpricedModels: [],
    },
    spendUsd: 0.0005,
  }
}

function statuses(facts: RepoFacts): Record<string, string> {
  return Object.fromEntries(
    evaluateRepo(facts).checks.map((check) => [check.id, check.status]),
  )
}

function detail(facts: RepoFacts, id: string): string | undefined {
  return evaluateRepo(facts).checks.find((check) => check.id === id)?.detail
}

describe("parseReposFile", () => {
  it("reads slugs, URLs, expected languages, and comments", () => {
    expect(
      parseReposFile(
        [
          "# validation set",
          "n8n-io/n8n typescript,JavaScript",
          "",
          "https://github.com/golang/go  go # Go toolchain",
        ].join("\n"),
      ),
    ).toEqual([
      {
        name: "n8n-io/n8n",
        gitUrl: "https://github.com/n8n-io/n8n",
        expectedLanguages: ["typescript", "javascript"],
      },
      {
        name: "https://github.com/golang/go",
        gitUrl: "https://github.com/golang/go",
        expectedLanguages: ["go"],
      },
    ])
  })

  it("rejects a line that names no repository", () => {
    expect(() => parseReposFile("not a repo")).toThrow(/Not a repository/)
  })
})

describe("stage timings", () => {
  it("groups admission retries and per-root steps", () => {
    expect(stepGroup("zoekt:admit-2")).toBe("zoekt")
    expect(stepGroup("scip:go:admit-1")).toBe("scip:go")
    expect(stepGroup("extract-kind:root-a")).toBe("extract-kind")
    expect(stepGroup("mark-success")).toBe("mark-success")
  })

  it("measures stages from native timestamps, skipping sleeps", () => {
    const facts = passingFacts()
    expect(stageDurations(facts)).toEqual({
      total: 150_000,
      codesearch: 38_000,
      extraction: 48_000,
      write: 20_000,
      hydrate: 39_000,
    })
    const timings = stepTimings(facts.runs, facts.steps)
    expect(timings.find((timing) => timing.step === "scip:typescript")).toEqual(
      {
        workflow: "repository-index",
        step: "scip:typescript",
        attempts: 2,
        failedAttempts: 1,
        wallMs: 26_000,
      },
    )
    expect(timings.some((timing) => timing.step === "await-write-access")).toBe(
      false,
    )
  })
})

describe("evaluateRepo", () => {
  it("passes a repository whose every stage checks out", () => {
    const report = evaluateRepo(passingFacts(), { HyperDX: "https://h/x" })
    expect(report.status).toBe("PASS")
    expect(statuses(passingFacts())).toEqual({
      "ingestion.attribution": "pass",
      "ingestion.workflow": "pass",
      "ingestion.repository_status": "pass",
      "codesearch.zoekt": "pass",
      "codesearch.scip": "pass",
      "extraction.destination": "pass",
      "extraction.commit": "pass",
      "extraction.knowledge_files": "pass",
      "hydrate.projection": "pass",
      "hydrate.units": "pass",
      "hydrate.graph": "pass",
      "hydrate.embeddings": "pass",
      "quality.size": "pass",
      "quality.graph": "pass",
      "telemetry.traces": "pass",
      "telemetry.llm": "pass",
      "telemetry.models": "pass",
    })
    expect(report.extractionCommitSha).toBe(commit)
    expect(detail(passingFacts(), "extraction.commit")).toContain(
      "Workspace git history not inspected",
    )
  })

  it("fails a SCIP language whose last attempt reported an issue, and a missing expected language", () => {
    const facts = passingFacts()
    facts.repo.expectedLanguages = ["typescript", "go"]
    const scip = facts.steps.find(
      (s) => s.stepName === "scip:typescript:admit-1",
    )
    if (scip)
      scip.output = {
        admitted: true,
        value: { ok: false, error: "tsconfig not found" },
      }
    expect(detail(facts, "codesearch.scip")).toBe(
      "not detected: go; typescript: tsconfig not found",
    )
    expect(evaluateRepo(facts).status).toBe("FAIL")
  })

  it("fails an extraction captured into another Workspace or recorded with another SHA", () => {
    const elsewhere = passingFacts()
    const extract = elsewhere.runs.find((r) => r.id === "run_extract")
    if (extract) extract.workspaceId = "ws_other"
    expect(detail(elsewhere, "extraction.destination")).toBe(
      "extraction captured ws_other, expected ws_1",
    )

    const mismatch = passingFacts()
    if (mismatch.extractJob) mismatch.extractJob.commitSha = "e".repeat(40)
    expect(statuses(mismatch)["extraction.commit"]).toBe("fail")
  })

  it("fails knowledge files that are malformed or not projected", () => {
    const facts = passingFacts()
    const hydrate = facts.runs.find((r) => r.id === "run_hydrate")
    if (hydrate)
      hydrate.output = {
        hydrated: true,
        diagnostics: [{ path: "services/app.md", reason: "malformed" }],
      }
    if (facts.repositoryUnits)
      facts.repositoryUnits.presentPaths = ["decisions/use-ts.md"]
    expect(detail(facts, "extraction.knowledge_files")).toBe(
      "malformed: services/app.md (malformed); 1 of 2 not projected (e.g. services/app.md)",
    )
  })

  it("fails units, graph and embeddings when the published projection is not the extraction commit", () => {
    const facts = passingFacts()
    facts.projection = {
      kind: "active",
      sha: "d".repeat(40),
      graph: "ready",
      embeddings: "ready",
    }
    expect(statuses(facts)).toMatchObject({
      "hydrate.projection": "pass",
      "hydrate.units": "fail",
      "hydrate.graph": "fail",
      "hydrate.embeddings": "fail",
    })
    expect(detail(facts, "hydrate.graph")).toBe(
      `published projection is at ${"d".repeat(40)}, extraction committed ${commit}`,
    )
  })

  it("fails stores that are not ready at the commit", () => {
    const facts = passingFacts()
    facts.projection = {
      kind: "active",
      sha: commit,
      graph: "failed",
      embeddings: "ready",
    }
    if (facts.repositoryUnits) facts.repositoryUnits.withoutEmbedding = 1
    expect(statuses(facts)).toMatchObject({
      "hydrate.graph": "fail",
      "hydrate.embeddings": "fail",
    })
  })

  it("applies quality thresholds to the repository's units, not the cumulative Workspace", () => {
    const facts = passingFacts()
    expect(statuses(facts)["quality.graph"]).toBe("pass")
    facts.quality = { ...quality, joinDensity: 0.1 }
    expect(detail(facts, "quality.graph")).toBe(
      "repository units: join 10.0%, orphans 0.0%, sourced 100.0%: join density < 30.0%",
    )
  })

  it("checks the final follow-up ingestion and requires every attributed run to succeed", () => {
    const facts = passingFacts()
    facts.ingestionRunIds = ["run_orch", "run_follow"]
    facts.runs.push(
      run("run_follow", "repository-ingestion-orchestrator", {
        rootRunId: "run_follow",
        status: "failed",
        error: { message: "boom" },
      }),
    )
    expect(detail(facts, "ingestion.workflow")).toBe(
      "follow-up 1: failed: boom",
    )
    // The final tree has no index or extraction of its own.
    expect(statuses(facts)).toMatchObject({
      "codesearch.zoekt": "fail",
      "extraction.commit": "fail",
    })
  })

  it("reports whether it waited for an in-flight ingestion or was coalesced", () => {
    const waited = passingFacts()
    waited.waitedFor = "run_other"
    expect(detail(waited, "ingestion.attribution")).toBe(
      "waited for in-flight ingestion run_other, then enqueued its own",
    )
    const coalesced = passingFacts()
    coalesced.coalescedInto = "run_other"
    expect(statuses(coalesced)["ingestion.attribution"]).toBe("fail")
  })

  it("warns when generations used a model other than GPT-6 Luna", () => {
    expect(
      unexpectedModels({
        "openai/gpt-6-luna": 3,
        "openai/text-embedding-3-large": 1,
        "xiaomi/mimo-v2.6-pro": 2,
      }),
    ).toEqual(["xiaomi/mimo-v2.6-pro"])
    const facts = passingFacts()
    if (facts.llm) facts.llm.models["xiaomi/mimo-v2.6-pro"] = 2
    expect(detail(facts, "telemetry.models")).toBe(
      "not GPT-6 Luna: xiaomi/mimo-v2.6-pro",
    )
  })

  it("warns that the cost of a model with no price reads as zero", () => {
    const facts = passingFacts()
    if (facts.llm) facts.llm.unpricedModels = ["vendor/no-price-anywhere"]
    expect(statuses(facts)["telemetry.llm"]).toBe("warn")
    expect(detail(facts, "telemetry.llm")).toContain(
      "no price for vendor/no-price-anywhere",
    )
  })

  it("warns on complete_with_issues and reports a timeout as TIMEOUT", () => {
    const issues = passingFacts()
    issues.repository = {
      indexingStatus: "complete_with_issues",
      indexingError: "scip:rust incomplete",
      lastIngestedHash: null,
      indexReady: true,
    }
    expect(evaluateRepo(issues).status).toBe("WARN")

    const slow = passingFacts()
    slow.timedOut = true
    const root = slow.runs.find((r) => r.id === "run_orch")
    if (root) root.status = "running"
    expect(evaluateRepo(slow).status).toBe("TIMEOUT")
    expect(detail(slow, "ingestion.workflow")).toBe(
      "ingestion: timed out while running",
    )
  })

  it("in index-only mode checks ingestion and codesearch only", () => {
    const facts = passingFacts()
    facts.mode = "index-only"
    facts.workspaceId = null
    facts.hydrateRunId = null
    facts.runs = facts.runs.filter((r) =>
      [
        "repository-ingestion-orchestrator",
        "repository-ingestion",
        "repository-index",
      ].includes(r.workflowName),
    )
    facts.llm = null
    const report = evaluateRepo(facts)
    expect(report.status).toBe("PASS")
    expect(report.checks.map((check) => check.id)).toEqual([
      "ingestion.attribution",
      "ingestion.workflow",
      "ingestion.repository_status",
      "codesearch.zoekt",
      "codesearch.scip",
      "extraction",
      "telemetry.traces",
    ])
  })

  it("reports a validator failure before any run existed", () => {
    const facts = passingFacts()
    facts.ingestionRunIds = []
    facts.runs = []
    facts.steps = []
    facts.error = "full mode needs ws_1 to be the org's only Workspace; found 2"
    const report = evaluateRepo(facts)
    expect(report.status).toBe("FAIL")
    expect(report.checks).toEqual([
      {
        id: "validator",
        status: "fail",
        detail: "full mode needs ws_1 to be the org's only Workspace; found 2",
      },
    ])
  })
})

describe("renderMarkdown", () => {
  function report(concurrency: number): ValidatorReport {
    const failing = passingFacts()
    failing.repo = { ...failing.repo, name: "example/broken" }
    failing.error = "lookup | failed"
    return {
      runId: "val_1",
      environment: "ingestion-validator",
      mode: "full",
      orgId: "org_1",
      workspaceId: "ws_1",
      concurrency,
      timeoutMinutes: 180,
      startedAt: at(0),
      finishedAt: at(300),
      configuredModels: {
        fast: "openai/gpt-6-luna?reasoning.effort=low",
        medium: null,
        high: null,
        embedding: null,
      },
      spend: { totalUsd: 0.5, limitUsd: 30 },
      links: { "HyperDX (all spans of this run)": "https://hyperdx/search" },
      repos: [
        evaluateRepo(passingFacts(), { Langfuse: "https://langfuse/session" }),
        evaluateRepo(failing),
      ],
    }
  }

  it("summarizes repositories, checks, models, LLM stages, runs, and links", () => {
    const markdown = renderMarkdown(report(1))
    expect(markdown).toContain("# Ingestion validator val_1")
    expect(markdown).toContain(
      "Models used (Langfuse generations): `openai/gpt-6-luna` ×2, `openai/text-embedding-3-large` ×2.",
    )
    expect(markdown).toContain("OpenRouter spend: $0.5000 (key limit $30).")
    expect(markdown).toContain("unverified query shape")
    expect(markdown).toContain(
      "| example/app | PASS | 150s | 38s | 48s | 20s | 39s | 2400 | $0.0005 |",
    )
    expect(markdown).toContain("| validator | FAIL | lookup \\| failed |")
    expect(markdown).toContain("| embeddings | 1 | 1000 | 200 | $0.0001 |")
    expect(markdown).toContain(
      "| not in Langfuse (OpenRouter delta − Langfuse total) | — | — | — | $0.0002 |",
    )
    expect(markdown).toContain(
      "Workspace at this SHA (cumulative across repositories, no thresholds): 12 units, join 20.0%",
    )
    expect(markdown).toContain(
      "repository-ingestion-orchestrator `run_orch` completed trace `0af7651916cd43dd8448eb211c80319c`",
    )
    expect(markdown).toContain("- Langfuse: https://langfuse/session")
  })

  it("says per-repository OpenRouter deltas are unavailable above concurrency 1", () => {
    expect(renderMarkdown(report(2))).toContain(
      "Per-repository OpenRouter deltas are unavailable at concurrency 2; use the per-stage Langfuse cost.",
    )
  })
})
