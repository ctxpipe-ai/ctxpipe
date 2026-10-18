/**
 * The Docker half of the ingestion v2 foundation proof (CTX-630). The manual
 * workflow `.github/workflows/ingestion-v2-proof.yaml` runs this script in the
 * backend container of the Compose `deploy` stack, through
 * `scripts/ci/ingestion-v2-proof.sh`. It prints one line that starts with
 * `PROOF_` and holds JSON; the shell script reads only those lines.
 *
 * Commands (apps/backend; DATABASE_URL, AUTH_SECRET, GITHUB_APP_ID and
 * GITHUB_PRIVATE_KEY come from the container):
 *   seed --workspace-repo <url> --repos <url,url,...>
 *       Makes a test org with one GitHub connection, indexes each repository
 *       in codesearch (no Workspace yet, so no model call runs), then makes one
 *       Workspace at format 3. The Workspace repository gets the format file
 *       and one source file per repository.
 *   start --org-id <org> --repo-url <url> --sha <sha>
 *       Queues one ingestion v2 run in shadow mode.
 *   estimate --org-id <org> --repos <url,url,...> --cap <usd>
 *       The p90 re-ingestion estimate of the Upgrades UI for all repositories,
 *       and whether it is over the cap.
 *   status --run-id <id> --spent-before <usd> --cap <usd>
 *       Reads the run tree: status, completed steps, model spend, steps in
 *       flight, patches, and the spend guard (spent plus reserved vs the cap).
 *   cancel --run-id <id>
 *       Cancels the run and its child runs.
 */
import { setTimeout as sleep } from "node:timers/promises"
import { eq, sql } from "drizzle-orm"
import { App } from "octokit"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { IngestionV2Input } from "../domain/ingestion/ingestion-run.js"
import { readIngestSkillBundle } from "../domain/ingestion/skill-bundle.js"
import {
  estimateReingest,
  ingestionRunSpend,
} from "../domain/upgrades/reingest.js"
import { githubSourcePath } from "../domain/workspace-sources/source-file.js"
import { renderSourceFile } from "../domain/workspace-sources/source-file-text.js"
import { resolveRepositoryReadTip } from "../domain/workspaces/resolve-revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { WORKSPACE_FORMAT_PATH } from "../domain/workspaces/workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  bulkCreateRepositoriesForOrg,
  findRepositoriesByNormalizedGitUrls,
} from "../models/repositories.js"
import { replaceWorkspaceSourceRows } from "../models/workspace-sources.js"
import { ow, runWorkflowWithWorkerWake } from "../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../openworkflow/enqueue-repository-ingestion.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { repositoryIngestionV2 } from "../openworkflow/workflows/repository-ingestion-v2.js"
import {
  estimateRefusal,
  isModelStepName,
  spendGuard,
} from "./ingestionV2ProofBudget.js"

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`)
  return value
}

function emit(kind: string, value: unknown): void {
  process.stdout.write(`PROOF_${kind} ${JSON.stringify(value)}\n`)
}

function note(message: string): void {
  process.stderr.write(`${message}\n`)
}

const TERMINAL = ["completed", "succeeded", "failed", "canceled"]

async function runStatus(runId: string): Promise<string | null> {
  const result = await getSystemDb().execute<{ status: string }>(sql`
    select status from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
  `)
  return result.rows[0]?.status ?? null
}

async function seed(argv: string[]): Promise<void> {
  const env = parseEnv(process.env)
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY)
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required")
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(
    flag(argv, "--workspace-repo"),
  )
  const repoUrls = flag(argv, "--repos")
    .split(",")
    .map((url) => normalizeWorkspaceRepositoryUrl(url.trim()))
  const workspaceName = githubRepoFullNameFromWorkspaceUrl(workspaceUrl)
  if (!workspaceName)
    throw new Error("The Workspace repository must be on GitHub")
  const [owner = ""] = workspaceName.split("/")
  const names = repoUrls.map((url) => {
    const name = githubRepoFullNameFromWorkspaceUrl(url)
    if (!name) throw new Error("Each repository must be on GitHub")
    if (name.split("/")[0]?.toLowerCase() !== owner.toLowerCase())
      throw new Error(
        "Each repository must be in the owner of the Workspace repository: the App installation covers one owner",
      )
    return name
  })

  const app = new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY.includes("\\n")
      ? env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n")
      : env.GITHUB_PRIVATE_KEY,
  })
  const installation = await app.octokit
    .request("GET /orgs/{org}/installation", { org: owner })
    .catch(() =>
      app.octokit.request("GET /users/{username}/installation", {
        username: owner,
      }),
    )
  const installationId = installation.data.id

  const orgId = generateObjectId("org")
  const org = { id: orgId, slug: `ingest-proof-${orgId.slice(-8)}` }
  const connectionId = generateObjectId("con")
  await getSystemDb()
    .insert(organizations)
    .values({ ...org, name: "Ingestion v2 proof", createdAt: new Date() })
  await withOrgDbContext(orgId, (db) =>
    db.insert(connections).values({
      id: connectionId,
      orgId,
      type: "github",
      config: {
        installationId,
        accountSlug: owner,
        ingestAllRepositories: false,
        includeFutureRepos: false,
      },
    }),
  )

  // Index each repository in codesearch. No Workspace exists yet, so the
  // ingestion stops after codesearch and no model call runs.
  const repositories: Array<{ url: string; name: string; sha: string }> = []
  for (const [index, url] of repoUrls.entries()) {
    const name = names[index] ?? url
    await bulkCreateRepositoriesForOrg(orgId, [{ name, gitUrl: url }], {
      githubConnectionId: connectionId,
    })
    const [repository] = await withOrgIdContext(org, () =>
      findRepositoriesByNormalizedGitUrls([url]),
    )
    if (!repository) throw new Error(`The repository ${name} was not created`)
    const tip = await resolveRepositoryReadTip({
      orgId,
      env,
      remote: { url, connectionId },
    })
    if (!tip) throw new Error(`The repository ${name} has no default branch`)
    const queued = await enqueueRepositoryIngestionWorkflow(
      { repositoryId: repository.id, orgId },
      { error: (error) => note(error.message) },
    )
    note(
      `Indexing ${name} at ${tip.sha.slice(0, 7)} (run ${queued.workflowRunId})`,
    )
    const deadline = Date.now() + 45 * 60_000
    for (;;) {
      const status = await runStatus(queued.workflowRunId)
      if (status && TERMINAL.includes(status)) {
        if (status === "failed" || status === "canceled")
          throw new Error(`Indexing of ${name} ended as ${status}`)
        break
      }
      if (Date.now() > deadline)
        throw new Error(`Indexing of ${name} did not finish in 45 minutes`)
      await sleep(10_000)
    }
    repositories.push({ url, name, sha: tip.sha })
  }

  // The Workspace repository: the format file and one source file for each
  // repository, committed on the default branch with the Contents API (this
  // also works on an empty repository).
  const octokit = await app.getInstallationOctokit(installationId)
  const [, workspaceRepo = ""] = workspaceName.split("/")
  const files: Array<{ path: string; content: string }> = [
    { path: WORKSPACE_FORMAT_PATH, content: "format: 3\n" },
    ...repositories.map((repository) => {
      const [repoOwner = "", repoName = ""] = repository.name.split("/")
      return {
        path: githubSourcePath(repoOwner, repoName),
        content: renderSourceFile(
          {
            path: githubSourcePath(repoOwner, repoName),
            provider: "github",
            connectionId,
            scope: { repository: repository.name },
          },
          `The ${repository.name} proof repository.\n`,
        ),
      }
    }),
  ]
  for (const file of files) {
    const existing = await octokit.rest.repos
      .getContent({ owner, repo: workspaceRepo, path: file.path })
      .then((response) =>
        "sha" in response.data && !Array.isArray(response.data)
          ? response.data.sha
          : undefined,
      )
      .catch(() => undefined)
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo: workspaceRepo,
      path: file.path,
      message: "Set up the ingestion proof Workspace",
      content: Buffer.from(file.content).toString("base64"),
      ...(existing ? { sha: existing } : {}),
    })
  }
  const workspaceTip = await resolveRepositoryReadTip({
    orgId,
    env,
    remote: { url: workspaceUrl, connectionId },
  })
  if (!workspaceTip) throw new Error("The Workspace repository has no tip")

  const workspaceId = generateObjectId("ws")
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: `proof-${workspaceId.slice(-8)}`,
      displayName: "Ingestion proof",
      workspaceRepositoryUrl: workspaceUrl,
      githubConnectionId: connectionId,
      desiredGeneration: 1,
      desiredSha: workspaceTip.sha,
      desiredDefaultBranch: workspaceTip.branch,
      writeStatus: "writable",
      formatVersion: 3,
    }),
  )
  await replaceWorkspaceSourceRows({
    orgId,
    workspaceId,
    revision: workspaceTip.sha,
    rows: repositories.map((repository) => ({
      sourceKey: githubSourcePath(
        repository.name.split("/")[0] ?? "",
        repository.name.split("/")[1] ?? "",
      ),
      provider: "github" as const,
      connectionId,
      scope: { repository: repository.name },
      status: "ok" as const,
      statusDetail: null,
    })),
  })
  emit("SEED", { orgId, connectionId, workspaceId, repositories })
}

async function start(argv: string[]): Promise<void> {
  const orgId = flag(argv, "--org-id")
  const url = normalizeWorkspaceRepositoryUrl(flag(argv, "--repo-url"))
  const sha = flag(argv, "--sha")
  const [connection] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.type, "github"))
      .limit(1),
  )
  if (!connection) throw new Error("The org has no GitHub connection")
  const input = {
    orgId,
    shadow: true,
    source: { kind: "github", url, githubConnectionId: connection.id },
    sha,
    authorTime: new Date().toISOString(),
  } satisfies IngestionV2Input
  const handle = await runWorkflowWithWorkerWake(
    repositoryIngestionV2.spec,
    input,
    { idempotencyKey: `ingestion-v2-proof:${orgId}:${sha}:${url}` },
  )
  emit("START", { runId: handle.workflowRun.id })
}

async function estimate(argv: string[]): Promise<void> {
  const orgId = flag(argv, "--org-id")
  const cap = Number(flag(argv, "--cap"))
  if (!Number.isFinite(cap) || cap <= 0)
    throw new Error("--cap must be above 0")
  const [connection] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.type, "github"))
      .limit(1),
  )
  if (!connection) throw new Error("The org has no GitHub connection")
  const repositories = flag(argv, "--repos")
    .split(",")
    .map((raw) => {
      const url = normalizeWorkspaceRepositoryUrl(raw.trim())
      const repository = githubRepoFullNameFromWorkspaceUrl(url)
      if (!repository) throw new Error("Each repository must be on GitHub")
      return { repository, url, githubConnectionId: connection.id }
    })
  const result = await estimateReingest({
    orgId,
    repositories,
    bundleSkills: (await readIngestSkillBundle()).skills,
  })
  emit("ESTIMATE", {
    capUsd: cap,
    costUsd: result.costUsd,
    minutes: result.minutes,
    perRepository: result.perRepository.map((r) => ({
      repository: r.repository,
      costUsd: r.costUsd,
      basis: r.basis,
    })),
    refusal: estimateRefusal(result, cap),
  })
}

/** The run and its child runs, to a depth of 8. */
const runTree = (runId: string) => sql`
  with recursive tree as (
    select run.id, 0 as depth from openworkflow.workflow_runs run
    where run.namespace_id = ${openWorkflowNamespaceId()} and run.id = ${runId}
    union all
    select child.id, tree.depth + 1 from tree
    join openworkflow.step_attempts attempt
      on attempt.namespace_id = ${openWorkflowNamespaceId()}
      and attempt.workflow_run_id = tree.id
      and attempt.child_workflow_run_id is not null
    join openworkflow.workflow_runs child
      on child.namespace_id = coalesce(attempt.child_workflow_run_namespace_id, ${openWorkflowNamespaceId()})
      and child.id = attempt.child_workflow_run_id
    where tree.depth < 8
  )
`

async function status(argv: string[]): Promise<void> {
  const runId = flag(argv, "--run-id")
  const spentBefore = Number(flag(argv, "--spent-before"))
  const cap = Number(flag(argv, "--cap"))
  if (!Number.isFinite(spentBefore) || !Number.isFinite(cap))
    throw new Error("--spent-before and --cap must be numbers")
  const db = getSystemDb()
  const root = await db.execute<{
    status: string
    output: unknown
    error: unknown
    started_at: string | Date | null
    finished_at: string | Date | null
  }>(sql`
    select status, output, error, started_at, finished_at
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
  `)
  const row = root.rows[0]
  if (!row) throw new Error("The run does not exist")
  // The model steps of the shard runs report their usage in their output.
  const usage = await db.execute<{
    steps: string
    unknown: string | null
    max_step_cost: string | null
  }>(sql`
    ${runTree(runId)}
    select
      count(*) filter (where attempt.status = 'completed'
        and attempt.step_name not in ('ensure-sandbox', 'destroy-sandbox')
        and run.workflow_name = 'ingestion-shard') as steps,
      sum((attempt.output->'usage'->>'unknownSteps')::numeric) as unknown,
      max((attempt.output->'usage'->>'costUsd')::numeric) as max_step_cost
    from tree
    join openworkflow.workflow_runs run
      on run.namespace_id = ${openWorkflowNamespaceId()} and run.id = tree.id
    join openworkflow.step_attempts attempt
      on attempt.namespace_id = ${openWorkflowNamespaceId()}
      and attempt.workflow_run_id = run.id
    where jsonb_typeof(attempt.output) = 'object'
  `)
  const counts = usage.rows[0]
  // Steps that run now, and the shards that finished a first step (each has
  // a sandbox that the credential check must inspect).
  const shardSteps = await db.execute<{
    run_id: string
    step_name: string
    status: string
  }>(sql`
    ${runTree(runId)}
    select attempt.workflow_run_id as run_id, attempt.step_name, attempt.status
    from tree
    join openworkflow.workflow_runs run
      on run.namespace_id = ${openWorkflowNamespaceId()} and run.id = tree.id
    join openworkflow.step_attempts attempt
      on attempt.namespace_id = ${openWorkflowNamespaceId()}
      and attempt.workflow_run_id = run.id
    where run.workflow_name = 'ingestion-shard'
      and attempt.step_name like 'skill:%'
      and attempt.status in ('running', 'completed')
  `)
  const inFlightModelSteps = shardSteps.rows.filter(
    (r) => r.status === "running" && isModelStepName(r.step_name),
  ).length
  const shardsWithFirstStep = new Set(
    shardSteps.rows
      .filter((r) => r.status === "completed")
      .map((r) => r.run_id),
  ).size
  // The finished cost, with the token price when a step reports no cost.
  const finished = await ingestionRunSpend(runId)
  const guard = spendGuard({
    spentUsd: spentBefore + finished.usd,
    inFlightModelSteps,
    capUsd: cap,
  })
  const output = (row.output ?? {}) as {
    status?: string
    reason?: string
    workspaces?: Array<{ ops?: number; rejects?: number; partial?: number }>
  }
  const sum = (key: "ops" | "rejects" | "partial") =>
    (output.workspaces ?? []).reduce((total, w) => total + (w[key] ?? 0), 0)
  const time = (value: string | Date | null) =>
    value ? new Date(value).getTime() : null
  emit("STATUS", {
    runId,
    status: row.status,
    terminal: TERMINAL.includes(row.status),
    outputStatus: output.status ?? null,
    outputReason: output.reason ?? null,
    error: row.error ?? null,
    completedSteps: Number(counts?.steps ?? 0),
    spendUsd: finished.usd,
    maxStepCostUsd: Number(counts?.max_step_cost ?? 0),
    unknownSteps: Number(counts?.unknown ?? 0),
    inFlightModelSteps,
    shardsWithFirstStep,
    reservedUsd: guard.reservedUsd,
    committedUsd: guard.committedUsd,
    stop: guard.stop,
    patches: sum("ops"),
    rejects: sum("rejects"),
    partial: sum("partial"),
    startedAtMs: time(row.started_at),
    finishedAtMs: time(row.finished_at),
  })
}

async function cancel(argv: string[]): Promise<void> {
  const runId = flag(argv, "--run-id")
  const tree = await getSystemDb().execute<{ id: string }>(sql`
    ${runTree(runId)}
    select id from tree
  `)
  for (const { id } of tree.rows) await ow.cancelWorkflowRun(id).catch(() => {})
  emit("CANCEL", { runIds: tree.rows.map((r) => r.id) })
}

const [command = "", ...rest] = process.argv.slice(2)
initDb(process.env.DATABASE_URL ?? "")
try {
  if (command === "seed") await seed(rest)
  else if (command === "start") await start(rest)
  else if (command === "estimate") await estimate(rest)
  else if (command === "status") await status(rest)
  else if (command === "cancel") await cancel(rest)
  else throw new Error("Use one of: seed, start, estimate, status, cancel")
} catch (error) {
  note(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  await closeDb()
  process.exit(process.exitCode ?? 0)
}
