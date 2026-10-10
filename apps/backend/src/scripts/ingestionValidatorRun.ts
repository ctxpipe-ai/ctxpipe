/**
 * The ingestion validator's run (entry and guards: `ingestionValidator.ts`).
 * Loads env and starts telemetry first: the OpenWorkflow client reads
 * DATABASE_URL when it loads.
 */
import "../observability/register.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { context } from "@opentelemetry/api"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
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
import {
  readExtractWriteJob,
  readRepositoryUnits,
  unitKinds,
} from "../models/repository-knowledge-units.js"
import { reconcileWorkspaceWriteJob } from "../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  getWorkspaceProjection,
  listLinkedRepositories,
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
import { extractionWriteJobId } from "../openworkflow/workflows/repository-ingestion.js"
import { extractionHydrateKey } from "../openworkflow/workflows/workspace-extract-ingest.js"
import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "../tools/codesearchZoekt.js"
import type { ValidatorOptions } from "./ingestionValidator.js"
import {
  assertExtractionDestination,
  findAttributedIngestions,
  findInFlightIngestion,
  findRunByIdempotencyKey,
  readRepositoryStatus,
  readRunTree,
} from "./ingestionValidatorQueries.js"
import {
  evaluateRepo,
  finalRuns,
  isTerminalRunStatus,
  type ProjectionFacts,
  type RepoFacts,
  type RepoSpec,
  renderMarkdown,
  runNamed,
  type ValidatorReport,
  type ZoektProbe,
} from "./ingestionValidatorReport.js"
import {
  hyperdxSearchUrl,
  type LangfuseConfig,
  langfuseSessionUrl,
  openRouterKey,
  readLangfuseProjectId,
  readOpenRouterKeyUsage,
  readRepositoryLlmUsage,
  waitForLangfuseIngestion,
} from "./ingestionValidatorTelemetry.js"
import {
  compareRepoGraph,
  estimateRepoGraph,
  measuredRepoGraph,
} from "./repoGraphSizeCheck.js"

type Run = ValidatorOptions & {
  org: { id: string; slug: string }
  namespaceId: string
  /** Set only at concurrency 1, where a per-repository delta is exact. */
  spend: (() => Promise<number>) | null
}

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every job this enqueue starts, and every child and follow-up of those, carries the run id. */
function withValidatorRequest<T>(run: Run, fn: () => Promise<T>): Promise<T> {
  const { context: withBag, bag } = contextWithAttributionBag(context.active())
  bag.set("request.id", run.runId)
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
  const admitted = await withValidatorRequest(run, () =>
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
    await sleep(run.pollSeconds * 1000)
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
    if (isZoektSearchClientFailure(result))
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

async function waitForTerminal(
  run: Run,
  runId: string,
  deadline: number,
): Promise<void> {
  for (;;) {
    const { runs } = await readRunTree({
      orgId: run.orgId,
      namespaceId: run.namespaceId,
      rootRunIds: [runId],
    })
    const root = runs.find((r) => r.id === runId)
    if (!root || isTerminalRunStatus(root.status)) return
    if (Date.now() > deadline)
      throw new Error(`in-flight ingestion ${runId} did not finish in time`)
    await sleep(run.pollSeconds * 1000)
  }
}

async function validateRepository(
  run: Run,
  repo: RepoSpec,
): Promise<RepoFacts> {
  const facts: RepoFacts = {
    repo,
    mode: run.mode,
    requestId: run.runId,
    workspaceId: run.workspaceId,
    repositoryId: null,
    enqueuedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    timedOut: false,
    error: null,
    waitedFor: null,
    coalescedInto: null,
    ingestionRunIds: [],
    hydrateRunId: null,
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
    workspaceQuality: null,
    qualityThresholds: run.qualityThresholds,
    llm: null,
    spendUsd: null,
  }
  const deadline = Date.now() + run.timeoutMinutes * 60_000
  const errors: string[] = []
  const spendBefore = run.spend ? await run.spend().catch(() => null) : null
  const tree = (rootRunIds: string[]) =>
    readRunTree({ orgId: run.orgId, namespaceId: run.namespaceId, rootRunIds })
  try {
    // Re-checked per repository: a Workspace added mid-run would make extraction spend.
    await assertExtractionDestination(run)
    const repositoryId = await withOrgIdContext(run.org, async () => {
      const row = await ensureOrgRepositoryForGitUrl({
        orgId: run.orgId,
        gitUrl: repo.gitUrl,
        githubConnectionId: run.workspaceId
          ? ((await getWorkspaceById(run.workspaceId))?.githubConnectionId ??
            null)
          : null,
      })
      if (!row) throw new Error("could not create the repository row")
      if (run.workspaceId)
        await linkToWorkspace(run, run.workspaceId, repo.gitUrl, deadline)
      return row.id
    })
    facts.repositoryId = repositoryId

    const inFlight = await findInFlightIngestion({
      orgId: run.orgId,
      namespaceId: run.namespaceId,
      repositoryId,
    })
    if (inFlight && inFlight.requestId !== run.runId) {
      facts.waitedFor = inFlight.id
      say(`${repo.name}: waiting for in-flight ingestion ${inFlight.id}`)
      await waitForTerminal(run, inFlight.id, deadline)
    }

    facts.enqueuedAt = new Date().toISOString()
    const { workflowRunId } = await withValidatorRequest(run, () =>
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
    const own = (await tree([workflowRunId])).runs.find(
      (r) => r.id === workflowRunId,
    )
    if (own?.requestId !== run.runId) {
      facts.coalescedInto = workflowRunId
      throw new Error(
        `ingestion coalesced into ${workflowRunId}, which the validator did not start`,
      )
    }
    say(`${repo.name}: enqueued ${workflowRunId} (${repositoryId})`)

    let last = ""
    for (;;) {
      facts.ingestionRunIds = await findAttributedIngestions({
        orgId: run.orgId,
        namespaceId: run.namespaceId,
        repositoryId,
        requestId: run.runId,
      })
      const read = await tree([
        ...facts.ingestionRunIds,
        ...(facts.hydrateRunId ? [facts.hydrateRunId] : []),
      ])
      facts.runs = read.runs
      facts.steps = read.steps
      const progress = read.runs
        .map((r) => `${r.workflowName}=${r.status}`)
        .join(" ")
      if (progress !== last) say(`${repo.name}: ${progress}`)
      last = progress
      // Done once every attributed ingestion (follow-ups included) is terminal…
      let done = facts.ingestionRunIds.every((id) => {
        const root = read.runs.find((r) => r.id === id)
        return root ? isTerminalRunStatus(root.status) : false
      })
      const final = finalRuns(facts)
      const ingestion = runNamed(final, "repository-ingestion")
      const committed =
        (
          runNamed(final, "workspace-write-extract-ingest")?.output as {
            committed?: unknown
          } | null
        )?.committed === true
      // …and, after a commit, its hydrate and the stores it refreshes are too.
      if (done && run.workspaceId && ingestion && committed) {
        const hydrateRunId = await findRunByIdempotencyKey({
          orgId: run.orgId,
          namespaceId: run.namespaceId,
          workflowName: "workspace-hydrate",
          idempotencyKey: extractionHydrateKey(
            extractionWriteJobId(ingestion.id),
          ),
        })
        if (hydrateRunId && hydrateRunId !== facts.hydrateRunId) {
          facts.hydrateRunId = hydrateRunId
          continue
        }
        const hydrate = read.runs.find((r) => r.id === facts.hydrateRunId)
        done = Boolean(hydrate && isTerminalRunStatus(hydrate.status))
        if (done && hydrate?.status !== "failed") {
          const workspaceId = run.workspaceId
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
      await sleep(run.pollSeconds * 1000)
    }
  } catch (error) {
    errors.push(message(error))
  }

  // Collect what exists even after a failure or timeout.
  const repositoryId = facts.repositoryId
  if (repositoryId && !facts.coalescedInto) {
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
    if (runNamed(finalRuns(facts), "repository-index"))
      facts.zoekt = await zoektProbe(run.orgId, repositoryId)
    const ingestion = runNamed(finalRuns(facts), "repository-ingestion")
    const workspaceId = run.workspaceId
    if (workspaceId && ingestion)
      await collect("workspace", () =>
        withOrgIdContext(run.org, async () => {
          facts.extractJob = await readExtractWriteJob(run.orgId, {
            jobId: extractionWriteJobId(ingestion.id),
          })
          const read = await readRepositoryUnits(
            workspaceId,
            Object.values(facts.extractJob?.knowledgePaths ?? {}),
          )
          facts.projection = projectionFacts(read.projection)
          facts.workspaceUnits = read.workspaceUnits.length
          facts.repositoryUnits = {
            kinds: unitKinds(read.units),
            units: read.units.length,
            withoutEmbedding: read.units.filter((unit) => !unit.embedding)
              .length,
            presentPaths: read.units.map((unit) => unit.path).sort(),
          }
          facts.quality = computeWorkspaceGraphQuality(
            read.units,
            hydrateUnitsToProjectionClaims(read.units),
          )
          facts.workspaceQuality = computeWorkspaceGraphQuality(
            read.workspaceUnits,
            hydrateUnitsToProjectionClaims(read.workspaceUnits),
          )
        }),
      )
    const sha = facts.repository?.lastIngestedHash
    const kinds = facts.repositoryUnits?.kinds
    if (sha && kinds)
      await collect("size", async () => {
        const paths = await listCheckoutTree({
          repositoryId,
          orgId: run.orgId,
          sha,
        })
        const { facts: sizeFacts, expected } = estimateRepoGraph(paths)
        facts.size = {
          facts: sizeFacts,
          rows: compareRepoGraph(expected, measuredRepoGraph(kinds)),
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

async function validate(options: ValidatorOptions): Promise<number> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  const [org] = await getSystemDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, options.orgId))
  if (!org) throw new Error(`Organization ${options.orgId} not found`)
  await assertExtractionDestination(options)
  if (options.workspaceId) {
    const workspaceId = options.workspaceId
    const row = await withOrgIdContext(org, () => getWorkspaceById(workspaceId))
    if (!row?.githubConnectionId)
      throw new Error("The validation Workspace needs a GitHub connection")
  }

  const env = parseEnv(process.env)
  const environment = otelDeploymentEnvironment()
  const key = openRouterKey(env)
  const readSpend = key
    ? () => readOpenRouterKeyUsage(key).then((usage) => usage.usage)
    : null
  const langfuseAuth = process.env.LANGFUSE_AUTH_STRING?.trim()
  const langfuse: LangfuseConfig | null = langfuseAuth
    ? { baseUrl: options.langfuseUrl, authString: langfuseAuth }
    : null
  const run: Run = {
    ...options,
    org,
    namespaceId: openWorkflowNamespaceId(),
    spend: options.concurrency === 1 ? readSpend : null,
  }
  // At concurrency 1 the per-repository reads bracket the whole run.
  const keyBefore =
    key && !run.spend
      ? await readOpenRouterKeyUsage(key).catch(() => null)
      : null
  const startedAt = new Date().toISOString()
  say(
    `validator ${options.runId}: ${options.repos.length} repositories, mode ${options.mode}, environment ${environment}`,
  )

  const results: RepoFacts[] = new Array(options.repos.length)
  let next = 0
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, options.repos.length) },
      async () => {
        for (;;) {
          const index = next++
          const repo = options.repos[index]
          if (!repo) return
          results[index] = await validateRepository(run, repo)
          say(`${repo.name}: finished`)
        }
      },
    ),
  )

  let projectId: string | null = null
  if (langfuse && options.mode === "full") {
    projectId = await readLangfuseProjectId(langfuse).catch(() => null)
    await waitForLangfuseIngestion(langfuse, {
      environment,
      from: startedAt,
    }).catch(() => 0)
    for (const facts of results) {
      if (!facts.repositoryId) continue
      facts.llm = await readRepositoryLlmUsage(langfuse, {
        repositoryId: facts.repositoryId,
        environment,
        exclusiveWindow: options.concurrency === 1,
        from: facts.enqueuedAt,
        to: facts.finishedAt,
      }).catch((error) => {
        facts.error = [facts.error, `langfuse: ${message(error)}`]
          .filter(Boolean)
          .join("; ")
        return null
      })
    }
  }
  const keyAfter = key
    ? await readOpenRouterKeyUsage(key).catch(() => null)
    : null
  const perRepository = results.map((facts) => facts.spendUsd)
  const totalUsd = run.spend
    ? perRepository.every((usd) => usd !== null)
      ? perRepository.reduce<number>((sum, usd) => sum + (usd ?? 0), 0)
      : null
    : keyBefore && keyAfter
      ? keyAfter.usage - keyBefore.usage
      : null
  const finishedAt = new Date().toISOString()

  const report: ValidatorReport = {
    runId: options.runId,
    environment,
    mode: options.mode,
    orgId: options.orgId,
    workspaceId: options.workspaceId,
    concurrency: options.concurrency,
    timeoutMinutes: options.timeoutMinutes,
    startedAt,
    finishedAt,
    configuredModels: {
      fast: env.MODEL_FAST_NAME ?? null,
      medium: env.MODEL_MEDIUM_NAME ?? null,
      high: env.MODEL_HIGH_NAME ?? null,
      embedding: env.MODEL_EMBEDDING_NAME ?? null,
    },
    spend: { totalUsd, limitUsd: keyAfter?.limit ?? null },
    links: {
      "HyperDX (all spans of this run)": hyperdxSearchUrl({
        baseUrl: options.hyperdxUrl,
        environment,
        attributes: { "request.id": options.runId },
        from: startedAt,
        to: finishedAt,
      }),
    },
    repos: results.map((facts) => {
      const ingestion = runNamed(finalRuns(facts), "repository-ingestion")
      const links: Record<string, string> = {}
      if (facts.repositoryId)
        links.HyperDX = hyperdxSearchUrl({
          baseUrl: options.hyperdxUrl,
          environment,
          attributes: {
            "request.id": options.runId,
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

  mkdirSync(options.outDir, { recursive: true })
  const jsonPath = join(options.outDir, `validator-${options.runId}.json`)
  const markdownPath = join(options.outDir, `validator-${options.runId}.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  const markdown = renderMarkdown(report)
  writeFileSync(markdownPath, markdown)
  process.stdout.write(
    `\n${markdown}\nwrote ${jsonPath}\nwrote ${markdownPath}\n`,
  )
  return report.repos.some(
    (repo) => repo.status === "FAIL" || repo.status === "TIMEOUT",
  )
    ? 1
    : 0
}

export async function runValidator(options: ValidatorOptions): Promise<number> {
  try {
    return await validate(options)
  } finally {
    await Promise.allSettled([
      closeOpenWorkflowClient(),
      closeDb(),
      flushEvlog(),
      shutdownOtel(),
    ])
  }
}
