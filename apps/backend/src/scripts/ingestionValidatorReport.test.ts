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
  type ValidatorReport,
} from "./ingestionValidatorReport.js"

const commit = "c".repeat(40)
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 3, 10, 0, seconds)).toISOString()

function run(
  id: string,
  workflowName: string,
  extra: Partial<ValidatorRun> = {},
): ValidatorRun {
  return {
    id,
    workflowName,
    status: "completed",
    parentRunId: null,
    parentStepName: null,
    output: null,
    error: null,
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

/** A full-mode ingestion where every stage succeeded. */
function passingFacts(): RepoFacts {
  return {
    repo: {
      name: "example/app",
      gitUrl: "https://github.com/example/app",
      expectedLanguages: ["typescript"],
    },
    mode: "full",
    repositoryId: "repo_1",
    enqueuedAt: at(0),
    finishedAt: at(200),
    timedOut: false,
    error: null,
    orchestratorRunId: "run_orch",
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
        startedAt: at(90),
        finishedAt: at(110),
        output: { committed: true, commitSha: commit },
      }),
      run("run_hydrate", "workspace-hydrate", {
        startedAt: at(111),
        finishedAt: at(150),
        revisionSha: commit,
        output: { hydrated: true, units: 12, skipped: 0, diagnostics: [] },
      }),
    ],
    steps: [
      step("run_index", "zoekt", 3, 10, {
        output: { admitted: true, value: { ok: true } },
      }),
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
      step("run_extract", "commit", 100, 101, {
        output: { sha: commit },
      }),
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
      sourceSha: "a".repeat(40),
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
    quality: {
      totalUnits: 12,
      totalClaims: 30,
      multiSourceUnits: 4,
      joinDensity: 0.33,
      orphanUnits: 1,
      orphanRate: 0.08,
      sourcedClaimRate: 0.97,
      kinds: {},
      predicates: {},
    },
    qualityThresholds: { minJoinDensity: 0.2, maxOrphanRate: 0.2 },
    llm: {
      stages: {
        "identify-roots": {
          calls: 1,
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          costUsd: 0.0002,
        },
      },
      total: {
        calls: 3,
        inputTokens: 5000,
        outputTokens: 900,
        totalTokens: 5900,
        costUsd: 0.00095,
      },
    },
    spendUsd: 0.001,
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

  it("measures stages from native run and step timestamps, skipping sleeps", () => {
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
      "ingestion.workflow": "pass",
      "ingestion.repository_status": "pass",
      "codesearch.zoekt": "pass",
      "codesearch.scip": "pass",
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
    })
    expect(report.extractionCommitSha).toBe(commit)
    expect(report.links).toEqual({ HyperDX: "https://h/x" })
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

  it("fails an extraction that took two commits or wrote unparseable knowledge", () => {
    const twoCommits = passingFacts()
    twoCommits.steps.push(step("run_extract", "commit", 102, 103))
    expect(detail(twoCommits, "extraction.commit")).toBe(
      "2 commit steps for one extraction",
    )

    const malformed = passingFacts()
    const hydrate = malformed.runs.find(
      (r) => r.workflowName === "workspace-hydrate",
    )
    if (hydrate)
      hydrate.output = {
        hydrated: true,
        diagnostics: [{ path: "services/app.md", reason: "malformed" }],
      }
    if (malformed.repositoryUnits)
      malformed.repositoryUnits.presentPaths = ["decisions/use-ts.md"]
    expect(detail(malformed, "extraction.knowledge_files")).toBe(
      "malformed: services/app.md (malformed); 1 of 2 not projected (e.g. services/app.md)",
    )
  })

  it("fails a hydrate that projected another SHA and stores that are not ready", () => {
    const facts = passingFacts()
    const hydrate = facts.runs.find(
      (r) => r.workflowName === "workspace-hydrate",
    )
    if (hydrate) hydrate.revisionSha = "d".repeat(40)
    facts.projection = {
      kind: "active",
      sha: commit,
      graph: "failed",
      embeddings: "ready",
    }
    if (facts.repositoryUnits) facts.repositoryUnits.withoutEmbedding = 1
    expect(statuses(facts)).toMatchObject({
      "hydrate.projection": "fail",
      "hydrate.graph": "fail",
      "hydrate.embeddings": "fail",
    })
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
    const report = evaluateRepo(slow)
    expect(report.status).toBe("TIMEOUT")
    expect(report.checks[0]).toEqual({
      id: "ingestion.workflow",
      status: "fail",
      detail: "timed out while running",
    })
  })

  it("in index-only mode skips extraction and fails if one ran or spent tokens", () => {
    const indexOnly = passingFacts()
    indexOnly.mode = "index-only"
    indexOnly.runs = indexOnly.runs.filter((r) =>
      [
        "repository-ingestion-orchestrator",
        "repository-ingestion",
        "repository-index",
      ].includes(r.workflowName),
    )
    indexOnly.llm = null
    const report = evaluateRepo(indexOnly)
    expect(report.status).toBe("PASS")
    expect(report.checks.map((check) => check.id)).toEqual([
      "ingestion.workflow",
      "ingestion.repository_status",
      "codesearch.zoekt",
      "codesearch.scip",
      "extraction.commit",
      "telemetry.traces",
      "telemetry.llm",
    ])

    const leaked = passingFacts()
    leaked.mode = "index-only"
    expect(statuses(leaked)).toMatchObject({
      "extraction.commit": "fail",
      "telemetry.llm": "fail",
    })
  })

  it("reports a validator failure before any run existed", () => {
    const facts = passingFacts()
    facts.orchestratorRunId = null
    facts.runs = []
    facts.steps = []
    facts.error =
      "link not admitted: Workspace writes require a connected GitHub repository"
    const report = evaluateRepo(facts)
    expect(report.status).toBe("FAIL")
    expect(report.checks).toEqual([
      {
        id: "validator",
        status: "fail",
        detail:
          "link not admitted: Workspace writes require a connected GitHub repository",
      },
    ])
  })
})

describe("renderMarkdown", () => {
  it("summarizes repositories, checks, LLM stages, runs, and links", () => {
    const facts = passingFacts()
    const failing = passingFacts()
    failing.repo = { ...failing.repo, name: "example/broken" }
    failing.error = "lookup | failed"
    const report: ValidatorReport = {
      runId: "val_1",
      environment: "ingestion-validator",
      mode: "full",
      orgId: "org_1",
      workspaceId: "ws_1",
      concurrency: 1,
      timeoutMinutes: 180,
      startedAt: at(0),
      finishedAt: at(300),
      models: {
        fast: "openai/gpt-6-luna?reasoning.effort=low",
        medium: null,
        high: null,
        embedding: null,
      },
      spend: { beforeUsd: 1, afterUsd: 1.5, limitUsd: 30 },
      links: { "HyperDX (all spans of this run)": "https://hyperdx/search" },
      repos: [
        evaluateRepo(facts, { Langfuse: "https://langfuse/session" }),
        evaluateRepo(failing),
      ],
    }
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("# Ingestion validator val_1")
    expect(markdown).toContain("OpenRouter spend: $0.5000 (key limit $30)")
    expect(markdown).toContain(
      "| example/app | PASS | 150s | 38s | 48s | 20s | 39s | 5900 | $0.0010 |",
    )
    expect(markdown).toContain("| validator | FAIL | lookup \\| failed |")
    expect(markdown).toContain("| identify-roots | 1 | 1000 | 200 | $0.0002 |")
    expect(markdown).toContain(
      "repository-ingestion-orchestrator `run_orch` completed trace `0af7651916cd43dd8448eb211c80319c`",
    )
    expect(markdown).toContain("- Langfuse: https://langfuse/session")
  })
})
