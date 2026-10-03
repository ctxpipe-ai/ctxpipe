/**
 * End-to-end ingestion validator (PR 280 ticket 04). For each repository in a
 * list: link it to the validation Workspace, enqueue a full ingestion stamped
 * with `ctxpipe.validator.run_id`, poll the native OpenWorkflow run tree and
 * the repository row until terminal, then check every stage — codesearch
 * (Zoekt + SCIP), the one extraction commit and its knowledge files, the
 * hydrate projection (units, graph, embeddings), graph size bounds and
 * quality — and record timings, trace ids, LLM tokens and OpenRouter spend.
 * Writes `validator-<run-id>.json` and `.md` to `--out-dir`.
 *
 * Usage (apps/backend; env from the target environment, e.g.
 * `railway ssh --environment <env> --service backend` then `cd apps/backend`):
 *   bun run src/scripts/ingestionValidator.ts --org-id <org> --workspace-id <ws> --repos repos.txt \
 *     [--concurrency 1] [--timeout-minutes 180] [--poll-seconds 15] [--out-dir .] [--run-id val_…] \
 *     [--quality-thresholds thresholds.json] [--hyperdx-url …] [--langfuse-url …]
 *   --mode index-only (no --workspace-id): codesearch only, for an org with no Workspace, so
 *     no extraction and no LLM call can run. The validator refuses an org that has one.
 *
 * Repos file: one `owner/name` or git URL per line, optionally followed by the SCIP
 * languages that must be indexed (`n8n-io/n8n typescript,javascript`).
 * Spend: OpenRouter usage of `MODEL_PROVIDER_API_KEY` before/after each repository.
 * Langfuse token totals need `LANGFUSE_AUTH_STRING` (ops/observability/USING.md).
 * Exits 1 unless every repository is PASS or WARN.
 */
import "../observability/register.js"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { context } from "@opentelemetry/api"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { listCheckoutTree } from "../domain/codeIngestion/codesearchClient.js"
import { ensureOrgRepositoryForGitUrl } from "../domain/workspaces/ensure-org-repository.js"
import { hydrateUnitsToProjectionClaims } from "../domain/workspaces/hydrate.js"
import { publishedProjection } from "../domain/workspaces/revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { computeWorkspaceGraphQuality } from "../domain/workspaces/workspace-graph.js"
import { generateObjectId } from "../lib/id.js"
import { getRepositoryForOrg } from "../models/repositories.js"
import { reconcileWorkspaceWriteJob } from "../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  listLinkedRepositories,
  listOrgWorkspaces,
} from "../models/workspaces.js"
import { contextWithAttributionBag } from "../observability/attribution.js"
import { flushEvlog } from "../observability/logger.js"
import {
  otelDeploymentEnvironment,
  shutdownOtel,
} from "../observability/otel.js"
import { closeOpenWorkflowClient } from "../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../openworkflow/enqueue-repository-ingestion.js"
import { enqueueWorkspaceWriteCommit } from "../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { zoektSearchRepository } from "../tools/codesearchZoekt.js"
import {
  findRunByIdempotencyKey,
  readExtractWriteJob,
  readRepositoryStatus,
  readRepositoryUnits,
  readRunTree,
} from "./ingestionValidatorQueries.js"
import {
  evaluateRepo,
  isTerminalRunStatus,
  type ProjectionFacts,
  parseReposFile,
  type QualityThresholds,
  type RepoFacts,
  type RepoSpec,
  renderMarkdown,
  type ValidatorMode,
  type ValidatorReport,
  type ZoektProbe,
} from "./ingestionValidatorReport.js"
import {
  hyperdxSearchUrl,
  type LangfuseConfig,
  langfuseSessionUrl,
  openRouterBaseUrl,
  readLangfuseProjectId,
  readOpenRouterKeyUsage,
  readRepositoryLlmUsage,
} from "./ingestionValidatorTelemetry.js"
import {
  compareRepoGraph,
  estimateRepoGraph,
  measuredRepoGraph,
} from "./repoGraphSizeCheck.js"

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function positiveInt(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}

type Run = {
  runId: string
  orgId: string
  org: { id: string; slug: string }
  mode: ValidatorMode
  workspace: { id: string; githubConnectionId: string | null } | null
  timeoutMs: number
  pollMs: number
  namespaceId: string
  qualityThresholds: QualityThresholds | null
  spend: (() => Promise<number>) | null
}

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every job this enqueue starts, and every child of those, carries the run id. */
function withValidatorAttribution<T>(
  run: Run,
  fn: () => Promise<T>,
): Promise<T> {
  const { context: withBag, bag } = contextWithAttributionBag(context.active())
  bag.set("ctxpipe.validator.run_id", run.runId)
  bag.set("ctxpipe.org.id", run.org.id)
  bag.set("ctxpipe.org.slug", run.org.slug)
  return context.with(withBag, fn)
}

async function linkToWorkspace(
  run: Run,
  workspaceId: string,
  gitUrl: string,
  deadline: number,
): Promise<void> {
  const wanted = normalizeWorkspaceRepositoryUrl(gitUrl)
  const linked = await listLinkedRepositories(workspaceId)
  if (
    linked.some((row) => normalizeWorkspaceRepositoryUrl(row.gitUrl) === wanted)
  )
    return
  const jobId = generateObjectId("wjob")
  const errors: string[] = []
  const admitted = await withValidatorAttribution(run, () =>
    enqueueWorkspaceWriteCommit(
      {
        orgId: run.orgId,
        workspaceId,
        jobId,
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: gitUrl,
      },
      { error: (error) => errors.push(error.message) },
    ),
  )
  if (!admitted.started)
    throw new Error(`link not admitted: ${errors.join("; ") || "unknown"}`)
  say(`  link ${jobId} queued`)
  for (;;) {
    const job = await reconcileWorkspaceWriteJob(jobId)
    if (job?.status === "completed") return
    if (job?.status === "failed") throw new Error(`link ${jobId} failed`)
    if (Date.now() > deadline) throw new Error(`link ${jobId} timed out`)
    await sleep(run.pollMs)
  }
}

async function zoektProbe(
  orgId: string,
  repositoryId: string,
): Promise<ZoektProbe> {
  try {
    const repository = await getRepositoryForOrg(orgId, repositoryId)
    if (!repository) return { ok: false, error: "repository row missing" }
    const result = await zoektSearchRepository(repository, "f:.", {
      ShardMaxMatchCount: 1,
      TotalMaxMatchCount: 1,
      MaxDocDisplayCount: 1,
    })
    if ("ok" in result && result.ok === false)
      return { ok: false, error: `${result.status} ${result.error}` }
    const nested = (result as { Result?: { Files?: unknown } }).Result?.Files
    const files = (result as { Files?: unknown }).Files ?? nested
    return { ok: true, files: Array.isArray(files) ? files.length : 0 }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

function projectionFacts(
  state: Awaited<ReturnType<typeof getWorkspaceProjection>>,
): ProjectionFacts {
  const published = publishedProjection(state)
  return {
    kind: state.kind,
    sha: published
      ? published.kind === "active"
        ? published.revision.sha
        : published.sha
      : null,
    graph: published?.kind === "active" ? published.stores.graph.kind : "none",
    embeddings:
      published?.kind === "active" ? published.stores.embeddings.kind : "none",
  }
}

async function validateRepository(
  run: Run,
  repo: RepoSpec,
): Promise<RepoFacts> {
  const facts: RepoFacts = {
    repo,
    mode: run.mode,
    repositoryId: null,
    enqueuedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    timedOut: false,
    error: null,
    orchestratorRunId: null,
    runs: [],
    steps: [],
    repository: null,
    zoekt: null,
    extractJob: null,
    projection: null,
    repositoryUnits: null,
    workspaceUnits: null,
    size: null,
    quality: null,
    qualityThresholds: run.qualityThresholds,
    llm: null,
    spendUsd: null,
  }
  const deadline = Date.now() + run.timeoutMs
  const errors: string[] = []
  const spendBefore = run.spend ? await run.spend().catch(() => null) : null
  try {
    const repositoryId = await withOrgIdContext(run.org, async () => {
      const row = await ensureOrgRepositoryForGitUrl({
        orgId: run.orgId,
        gitUrl: repo.gitUrl,
        githubConnectionId: run.workspace?.githubConnectionId ?? null,
      })
      if (!row) throw new Error("could not create the repository row")
      if (run.workspace)
        await linkToWorkspace(run, run.workspace.id, repo.gitUrl, deadline)
      return row.id
    })
    facts.repositoryId = repositoryId
    facts.enqueuedAt = new Date().toISOString()
    const { workflowRunId } = await withValidatorAttribution(run, () =>
      enqueueRepositoryIngestionWorkflow(
        {
          repositoryId,
          orgId: run.orgId,
          indexingReason: `ingestion validator ${run.runId}`,
          fullReingest: true,
        },
        { error: (error) => errors.push(error.message) },
      ),
    )
    facts.orchestratorRunId = workflowRunId
    say(`${repo.name}: enqueued ${workflowRunId} (${repositoryId})`)

    const roots = [workflowRunId]
    let last = ""
    for (;;) {
      const tree = await readRunTree({
        orgId: run.orgId,
        namespaceId: run.namespaceId,
        rootRunIds: roots,
      })
      facts.runs = tree.runs
      facts.steps = tree.steps
      const progress = tree.runs
        .map((r) => `${r.workflowName}=${r.status}`)
        .join(" ")
      if (progress !== last) say(`${repo.name}: ${progress}`)
      last = progress
      const root = tree.runs.find((r) => r.id === workflowRunId)
      let done = Boolean(root && isTerminalRunStatus(root.status))
      const ingestion = tree.runs.find(
        (r) => r.workflowName === "repository-ingestion",
      )
      const extract = tree.runs.find(
        (r) => r.workflowName === "workspace-write-extract-ingest",
      )
      const committed =
        (extract?.output as { committed?: unknown } | null)?.committed === true
      if (done && run.workspace && ingestion && committed) {
        const hydrateRunId = await findRunByIdempotencyKey({
          orgId: run.orgId,
          namespaceId: run.namespaceId,
          workflowName: "workspace-hydrate",
          idempotencyKey: `wjob_${ingestion.id}_extract:hydrate`,
        })
        if (hydrateRunId && !roots.includes(hydrateRunId)) {
          roots.push(hydrateRunId)
          continue
        }
        const hydrate = tree.runs.find((r) => r.id === hydrateRunId)
        done = Boolean(hydrate && isTerminalRunStatus(hydrate.status))
        if (done && hydrate?.status !== "failed") {
          const workspaceId = run.workspace.id
          const projection = projectionFacts(
            await withOrgIdContext(run.org, () =>
              getWorkspaceProjection(workspaceId),
            ),
          )
          done =
            projection.graph !== "pending" &&
            projection.embeddings !== "pending"
        }
      }
      if (done) break
      if (Date.now() > deadline) {
        facts.timedOut = true
        break
      }
      await sleep(run.pollMs)
    }
  } catch (error) {
    errors.push(message(error))
  }

  // Collect what exists even after a failure or timeout.
  const repositoryId = facts.repositoryId
  if (repositoryId) {
    const collect = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (error) {
        errors.push(`${what}: ${message(error)}`)
      }
    }
    await collect("repository", async () => {
      facts.repository = await readRepositoryStatus(run.orgId, repositoryId)
    })
    if (facts.runs.some((r) => r.workflowName === "repository-index"))
      facts.zoekt = await zoektProbe(run.orgId, repositoryId)
    const ingestion = facts.runs.find(
      (r) => r.workflowName === "repository-ingestion",
    )
    const workspace = run.workspace
    if (workspace && ingestion)
      await collect("workspace", () =>
        withOrgIdContext(run.org, async () => {
          facts.extractJob = await readExtractWriteJob(run.orgId, {
            jobId: `wjob_${ingestion.id}_extract`,
          })
          facts.projection = projectionFacts(
            await getWorkspaceProjection(workspace.id),
          )
          const snapshot = await getWorkspaceProjectionSnapshot(workspace.id)
          facts.workspaceUnits = snapshot.units.length
          facts.quality = computeWorkspaceGraphQuality(
            snapshot.units,
            hydrateUnitsToProjectionClaims(snapshot.units),
          )
          if (facts.projection.sha)
            facts.repositoryUnits = await readRepositoryUnits({
              orgId: run.orgId,
              workspaceId: workspace.id,
              projectionSha: facts.projection.sha,
              paths: [
                ...new Set(
                  Object.values(facts.extractJob?.knowledgePaths ?? {}),
                ),
              ],
            })
        }),
      )
    const sha = facts.repository?.lastIngestedHash
    if (workspace && sha && facts.repositoryUnits)
      await collect("size", async () => {
        const paths = await listCheckoutTree({
          repositoryId,
          orgId: run.orgId,
          sha,
        })
        const { facts: sizeFacts, expected } = estimateRepoGraph(paths)
        facts.size = {
          facts: sizeFacts,
          rows: compareRepoGraph(
            expected,
            measuredRepoGraph(facts.repositoryUnits?.kinds ?? {}),
          ),
        }
      })
  }
  const spendAfter = run.spend ? await run.spend().catch(() => null) : null
  if (spendBefore !== null && spendAfter !== null)
    facts.spendUsd = spendAfter - spendBefore
  facts.finishedAt = new Date().toISOString()
  if (errors.length) facts.error = errors.join("; ")
  return facts
}

async function main(argv: string[]): Promise<void> {
  const orgId = flag(argv, "--org-id")
  const reposFile = flag(argv, "--repos")
  if (!orgId || !reposFile) throw new Error("--org-id and --repos are required")
  const mode = (flag(argv, "--mode") ?? "full") as ValidatorMode
  if (mode !== "full" && mode !== "index-only")
    throw new Error("--mode is full or index-only")
  const workspaceId = flag(argv, "--workspace-id")
  if (mode === "full" && !workspaceId)
    throw new Error("--workspace-id is required in full mode")
  const repos = parseReposFile(readFileSync(reposFile, "utf8"))
  if (repos.length === 0) throw new Error("the repos file lists no repository")
  const concurrency = positiveInt(argv, "--concurrency", 1)
  const timeoutMinutes = positiveInt(argv, "--timeout-minutes", 180)
  const pollSeconds = positiveInt(argv, "--poll-seconds", 15)
  const outDir = resolve(flag(argv, "--out-dir") ?? ".")
  const runId =
    flag(argv, "--run-id") ??
    `val_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`
  const thresholdsFile = flag(argv, "--quality-thresholds")
  const environment = otelDeploymentEnvironment()
  const hyperdxUrl = flag(argv, "--hyperdx-url") ?? "https://hyperdx.ctxpipe.ai"
  const langfuseAuth = process.env.LANGFUSE_AUTH_STRING?.trim()
  const langfuse: LangfuseConfig | null = langfuseAuth
    ? {
        baseUrl: flag(argv, "--langfuse-url") ?? "https://langfuse.ctxpipe.ai",
        authString: langfuseAuth,
      }
    : null

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  const [org] = await getSystemDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
  if (!org) throw new Error(`Organization ${orgId} not found`)

  const workspaces = await withOrgIdContext(org, () => listOrgWorkspaces(orgId))
  let workspace: Run["workspace"] = null
  if (mode === "index-only") {
    // Extraction runs only for an org with a Workspace; none means no LLM call.
    if (workspaces.length > 0)
      throw new Error(
        "index-only mode needs an org with no Workspace (extraction would run and spend)",
      )
  } else {
    const row = await withOrgIdContext(org, () =>
      getWorkspaceById(workspaceId as string),
    )
    if (!row) throw new Error(`Workspace ${workspaceId} not found in ${orgId}`)
    if (!row.githubConnectionId)
      throw new Error("The validation Workspace needs a GitHub connection")
    workspace = { id: row.id, githubConnectionId: row.githubConnectionId }
  }

  const providerBase = openRouterBaseUrl(process.env)
  const apiKey = process.env.MODEL_PROVIDER_API_KEY?.trim()
  const spend =
    providerBase && apiKey
      ? () =>
          readOpenRouterKeyUsage({ baseUrl: providerBase, apiKey }).then(
            (usage) => usage.usage,
          )
      : null
  const keyBefore =
    providerBase && apiKey
      ? await readOpenRouterKeyUsage({ baseUrl: providerBase, apiKey }).catch(
          () => null,
        )
      : null
  const run: Run = {
    runId,
    orgId,
    org,
    mode,
    workspace,
    timeoutMs: timeoutMinutes * 60_000,
    pollMs: pollSeconds * 1000,
    namespaceId: openWorkflowNamespaceId(),
    qualityThresholds: thresholdsFile
      ? (JSON.parse(readFileSync(thresholdsFile, "utf8")) as QualityThresholds)
      : null,
    // Per-repository deltas are exact only one repository at a time.
    spend: concurrency === 1 ? spend : null,
  }
  const startedAt = new Date().toISOString()
  say(
    `validator ${runId}: ${repos.length} repositories, mode ${mode}, environment ${environment}`,
  )

  const results: RepoFacts[] = new Array(repos.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, repos.length) }, async () => {
      for (;;) {
        const index = next++
        const repo = repos[index]
        if (!repo) return
        results[index] = await validateRepository(run, repo)
        say(`${repo.name}: finished`)
      }
    }),
  )

  // Generations reach Langfuse through the collector's batch exporter.
  const projectId =
    langfuse && mode === "full"
      ? await readLangfuseProjectId(langfuse).catch(() => null)
      : null
  if (langfuse) {
    await sleep(60_000)
    for (const facts of results) {
      if (!facts.repositoryId) continue
      facts.llm = await readRepositoryLlmUsage(langfuse, {
        repositoryId: facts.repositoryId,
        from: facts.enqueuedAt,
        to: new Date().toISOString(),
      }).catch((error) => {
        facts.error = [facts.error, `langfuse: ${message(error)}`]
          .filter(Boolean)
          .join("; ")
        return null
      })
    }
  }
  const keyAfter =
    providerBase && apiKey
      ? await readOpenRouterKeyUsage({ baseUrl: providerBase, apiKey }).catch(
          () => null,
        )
      : null
  const finishedAt = new Date().toISOString()

  const report: ValidatorReport = {
    runId,
    environment,
    mode,
    orgId,
    workspaceId: workspace?.id ?? null,
    concurrency,
    timeoutMinutes,
    startedAt,
    finishedAt,
    models: {
      fast: process.env.MODEL_FAST_NAME ?? null,
      medium: process.env.MODEL_MEDIUM_NAME ?? null,
      high: process.env.MODEL_HIGH_NAME ?? null,
      embedding: process.env.MODEL_EMBEDDING_NAME ?? null,
    },
    spend: {
      beforeUsd: keyBefore?.usage ?? null,
      afterUsd: keyAfter?.usage ?? null,
      limitUsd: keyAfter?.limit ?? keyBefore?.limit ?? null,
    },
    links: {
      "HyperDX (all spans of this run)": hyperdxSearchUrl({
        baseUrl: hyperdxUrl,
        environment,
        attributes: { "ctxpipe.validator.run_id": runId },
        from: startedAt,
        to: finishedAt,
      }),
    },
    repos: results.map((facts) => {
      const ingestion = facts.runs.find(
        (r) => r.workflowName === "repository-ingestion",
      )
      const links: Record<string, string> = {}
      if (facts.repositoryId)
        links.HyperDX = hyperdxSearchUrl({
          baseUrl: hyperdxUrl,
          environment,
          attributes: {
            "ctxpipe.validator.run_id": runId,
            "ctxpipe.repository.id": facts.repositoryId,
          },
          from: facts.enqueuedAt,
          to: facts.finishedAt,
        })
      if (langfuse && projectId && ingestion)
        links.Langfuse = langfuseSessionUrl({
          baseUrl: langfuse.baseUrl,
          projectId,
          repositoryIngestionRunId: ingestion.id,
        })
      return evaluateRepo(facts, links)
    }),
  }

  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, `validator-${runId}.json`)
  const markdownPath = join(outDir, `validator-${runId}.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  const markdown = renderMarkdown(report)
  writeFileSync(markdownPath, markdown)
  process.stdout.write(
    `\n${markdown}\nwrote ${jsonPath}\nwrote ${markdownPath}\n`,
  )
  if (
    report.repos.some(
      (repo) => repo.status === "FAIL" || repo.status === "TIMEOUT",
    )
  )
    process.exitCode = 1
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .catch((error) => {
      process.stderr.write(`${message(error)}\n`)
      process.exitCode = 1
    })
    .finally(async () => {
      await Promise.allSettled([
        closeOpenWorkflowClient(),
        closeDb(),
        flushEvlog(),
        shutdownOtel(),
      ])
      process.exit(process.exitCode ?? 0)
    })
}
