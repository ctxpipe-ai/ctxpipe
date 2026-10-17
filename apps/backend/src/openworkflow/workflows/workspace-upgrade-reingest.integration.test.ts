import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import {
  orgFirstWorkspaces,
  workspaces,
  workspaceWriteJobs,
} from "../../db/schema/workspaces.js"
import { readIngestSkillBundle } from "../../domain/ingestion/skill-bundle.js"
import {
  UPGRADE_STATUSES,
  upgradeJobId,
} from "../../domain/upgrades/registry.js"
import {
  estimateReingest,
  reingestUpgradeKey,
  workspaceSourceRepositories,
} from "../../domain/upgrades/reingest.js"
import { startWorkspaceUpgrade } from "../../domain/upgrades/start.js"
import { githubSourcePath } from "../../domain/workspace-sources/source-file.js"
import { workspaceFormatFile } from "../../domain/workspaces/workspace-format.js"
import { generateObjectId } from "../../lib/id.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import {
  deleteSupersededUpgradeRows,
  failStoppedUpgradeRun,
  getWorkspaceUpgradeRow,
  insertWorkspaceUpgradeRow,
  listWorkspaceUpgradeRows,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import { standInIngestShardRuntime } from "../../test/ingest-shard-stand-in.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { defineIngestionShardWorkflow } from "./ingestion-shard.js"
import { defineRepositoryIngestionV2Workflow } from "./repository-ingestion-v2.js"
import { defineWorkspaceExtractIngestWorkflow } from "./workspace-extract-ingest.js"
import { workspaceOwnershipMigration } from "./workspace-ownership-migration.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"
import {
  defineWorkspaceUpgradeReingest,
  defineWorkspaceUpgradeReingestRepository,
} from "./workspace-upgrade-reingest.js"
import { defineWorkspaceUpgradeScan } from "./workspace-upgrade-scan.js"

vi.hoisted(() => {
  process.env.OPENWORKFLOW_NAMESPACE_ID = `test-upgrade-reingest-${Math.random().toString(36).slice(2, 10)}`
})

/*
 * The re-ingestion upgrade (CTX-746) end to end, with real Postgres, a real
 * OpenWorkflow worker, the real ingestion v2 workflow, the real broker, and
 * real git. GitHub is a set of local bare repositories
 * (`url.<dir>.insteadOf https://github.com/`); msw mints the GitHub tokens
 * and answers the model calls of the stand-in sandbox. This file has its own
 * OpenWorkflow namespace, so its worker claims no run of another test file.
 */

const MODEL_URL = "https://reingest-model.test/v1/step"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}

const org = { id: generateObjectId("org"), slug: "" }
org.slug = org.id
const connectionId = generateObjectId("con")
const suffix = Math.random().toString(36).slice(2, 8)
const sourceName = `acme/billing-api-${suffix}`
const otherSource = `acme/ledger-${suffix}`
const contexts = [`acme/context-a-${suffix}`, `acme/context-b-${suffix}`]
const capSources = [`acme/cap-a-${suffix}`, `acme/cap-b-${suffix}`]
contexts.push(
  `acme/context-c-${suffix}`,
  `acme/context-d-${suffix}`,
  `acme/context-e-${suffix}`,
)
const [ready, behind, capped, wide, yamlOnly] = [
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
]
// The source repositories of each Workspace. `wide` also links the source
// of `ready`. `yamlOnly` links its repository only in
// `.ctxpipe/sources.yaml`, so ingestion v2 has no destination in it.
const sourcesOf = [
  [sourceName],
  [otherSource],
  capSources,
  [sourceName, otherSource, capSources[0] ?? ""],
  [otherSource],
]
/** The USD that each model step of a Workspace reports. */
const stepCostUsd = new Map<string, number>()
/** The Workspaces whose model steps report no usage, as a runtime that cannot. */
const noUsage = new Set<string>()
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
const modelCalls: string[] = []

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => "fixture-only-github-token"),
  http.post(MODEL_URL, async ({ request }) => {
    const body = (await request.json()) as { workspaceId: string }
    modelCalls.push(body.workspaceId)
    const costUsd = stepCostUsd.get(body.workspaceId)
    return HttpResponse.json({
      more: false,
      ...(noUsage.has(body.workspaceId)
        ? {}
        : {
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              ...(costUsd ? { costUsd } : {}),
            },
          }),
      files: [
        {
          path: "knowledge/services/billing-api.md",
          content:
            "---\nkind: Service\nname: billing-api\n---\n# billing-api\n\nThe billing-api service sends invoices.\n",
        },
      ],
    })
  }),
)

let folder: string
let remotes: string
let backend: BackendPostgres
let worker: ReturnType<OpenWorkflow["newWorker"]>
let runner: OpenWorkflow
let scan: ReturnType<typeof defineWorkspaceUpgradeScan>
let reingest: ReturnType<typeof defineWorkspaceUpgradeReingest>

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

function remote(name: string, files: Record<string, string>): string {
  const work = mkdtempSync(join(folder, "work-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "seed")
  const bare = join(remotes, name)
  mkdirSync(dirname(bare), { recursive: true })
  execFileSync("git", ["clone", "-q", "--bare", work, bare])
  return git(work, "rev-parse", "HEAD")
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for the re-ingestion upgrade")
  initDb(databaseUrl)
  stubGithubApp()
  vi.stubEnv("SANDBOX_PROVIDER", "docker")
  server.listen({ onUnhandledRequest: "bypass" })
  folder = mkdtempSync(join(tmpdir(), "upgrade-reingest-"))
  remotes = join(folder, "remotes")
  const gitConfig = join(folder, "gitconfig")
  writeFileSync(
    gitConfig,
    `[url "${remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n[uploadpack]\n\tallowAnySHA1InWant = true\n`,
  )
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig)
  remote(sourceName, {
    "package.json": '{ "name": "billing-api" }\n',
    "README.md": "# Billing API\n",
  })
  remote(otherSource, { "README.md": "# Ledger\n" })
  for (const name of capSources)
    remote(name, { "package.json": '{ "name": "cap" }\n' })
  // The tree of each Workspace has the format of its row: ingestion v2
  // reads the format at the pinned commit before it publishes (G5).
  // Each source file is in the tree too: the publish checks it.
  const pinned = contexts.map((name, i) => {
    const format = workspaceFormatFile(i === 1 ? 2 : 3)
    return remote(name, {
      "README.md": "# Context\n",
      [format.path]: format.content,
      ...(i === 4
        ? {}
        : Object.fromEntries(
            (sourcesOf[i] ?? []).map((repository) => {
              const [owner = "", repo = ""] = repository.split("/")
              return [
                githubSourcePath(owner, repo),
                `---\nprovider: github\nconnection: ${connectionId}\nrepository: ${repository}\n---\n`,
              ]
            }),
          )),
    })
  })

  // The real stage helpers and script skills, and one fixture model skill.
  const real = await readIngestSkillBundle()
  const bundleDir = join(folder, "bundle")
  for (const file of real.files.filter((f) =>
    ["bin", "discover-roots", "repository"].includes(
      f.path.split("/")[0] ?? "",
    ),
  )) {
    mkdirSync(dirname(join(bundleDir, file.path)), { recursive: true })
    writeFileSync(join(bundleDir, file.path), file.content, {
      mode: file.executable ? 0o755 : 0o644,
    })
  }
  mkdirSync(join(bundleDir, "classify-kind"))
  writeFileSync(
    join(bundleDir, "classify-kind/SKILL.md"),
    "---\nname: classify-kind\ndescription: Fixture model skill.\n---\n# classify-kind\n",
  )

  await getSystemDb().insert(organizations).values({
    id: org.id,
    slug: org.slug,
    name: "Re-ingestion upgrade proof",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId: org.id,
    id: connectionId,
    installationId: 446,
    accountSlug: "acme",
  })
  // `ready`, `capped`, `wide` and `yamlOnly` are at format 3. `wide` has
  // more source repositories than the step budget of this file holds.
  // `behind` is at format 2, so it must merge the format upgrade first (G5).
  for (const [i, workspaceId] of [
    ready,
    behind,
    capped,
    wide,
    yamlOnly,
  ].entries()) {
    await withOrgDbContext(org.id, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: `reingest-${i}-${suffix}`,
        displayName: `Re-ingest ${i}`,
        workspaceRepositoryUrl: `https://github.com/${contexts[i]}`,
        githubConnectionId: connectionId,
        desiredGeneration: 3,
        desiredSha: pinned[i],
        desiredDefaultBranch: "main",
        writeStatus: "writable",
        formatVersion: i === 1 ? 2 : 3,
      }),
    )
    await replaceWorkspaceSourceRows({
      orgId: org.id,
      workspaceId,
      revision: pinned[i] ?? "",
      // One source file for each repository.
      rows: (sourcesOf[i] ?? []).map((name) => {
        const [owner = "", repo = ""] = name.split("/")
        return {
          // A `.ctxpipe/sources.yaml` entry has its id as the key.
          sourceKey: i === 4 ? "ledger" : githubSourcePath(owner, repo),
          provider: "github",
          connectionId,
          scope: { repositories: [name] },
          status: "ok",
          statusDetail: null,
        }
      }),
    })
  }

  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  runner = new OpenWorkflow({ backend })
  const deps = {
    runtime: standInIngestShardRuntime({ modelUrl: MODEL_URL, folder }),
    bundle: () => readIngestSkillBundle(bundleDir),
  }
  const shard = defineIngestionShardWorkflow(deps)
  const parent = defineRepositoryIngestionV2Workflow({ ...deps, shard })
  const extract = defineWorkspaceExtractIngestWorkflow()
  scan = defineWorkspaceUpgradeScan([])
  const throttle = {
    firstPollSeconds: 1,
    maxSlotPollSeconds: 1,
    maxRunPollSeconds: 1,
  }
  const repository = defineWorkspaceUpgradeReingestRepository({ throttle })
  // 11 step attempts hold 2 repositories: 5 fixed, 2 for each repository, and
  // one slot poll of 2.
  reingest = defineWorkspaceUpgradeReingest({
    throttle,
    repository,
    stepBudget: 11,
  })
  runner.implementWorkflow(shard.spec, shard.fn)
  runner.implementWorkflow(parent.spec, parent.fn)
  runner.implementWorkflow(extract.spec, extract.fn)
  runner.implementWorkflow(
    workspaceOwnershipMigration.spec,
    workspaceOwnershipMigration.fn,
  )
  runner.implementWorkflow(
    workspaceSemanticMerge.spec,
    workspaceSemanticMerge.fn,
  )
  runner.implementWorkflow(scan.spec, scan.fn)
  runner.implementWorkflow(repository.spec, repository.fn)
  runner.implementWorkflow(reingest.spec, reingest.fn)
  worker = runner.newWorker({ concurrency: 4 })
  await worker.start()
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await backend?.stop()
  server.close()
  vi.unstubAllEnvs()
  await withOrgDbContext(org.id, async (db) => {
    await db
      .delete(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.orgId, org.id))
    await db
      .delete(orgFirstWorkspaces)
      .where(eq(orgFirstWorkspaces.orgId, org.id))
    await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
    await db.delete(connections).where(eq(connections.orgId, org.id))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, org.id))
  await closeDb()
  rmSync(folder, { recursive: true, force: true })
}, 60_000)

let scans = 0
async function runScan() {
  const handle = await runner.runWorkflow(scan.spec, {
    orgId: org.id,
    release: "test",
    trigger: `scan-${++scans}`,
  })
  return handle.result({ timeoutMs: 60_000 })
}

/** The row of the Workspace when its run ended. */
async function settled(workspaceId: string) {
  let current = await row(workspaceId)
  for (
    let i = 0;
    i < 360 &&
    current?.status !== "completed" &&
    current?.status !== "failed" &&
    current?.status !== "blocked";
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    current = await row(workspaceId)
  }
  return current
}

/** Set the row of the Workspace, as a run or a scan of the past left it. */
async function setRow(
  workspaceId: string,
  fields: Omit<
    Parameters<typeof transitionWorkspaceUpgradeRow>[0],
    "workspaceId" | "key" | "from"
  >,
) {
  await withOrgIdContext(org, async () =>
    transitionWorkspaceUpgradeRow({
      workspaceId,
      key: await key(),
      from: Object.values(UPGRADE_STATUSES),
      ...fields,
    }),
  )
}

/** An upgrade run of the Workspace that ended before it did its work. */
async function endedUpgradeRun(workspaceId: string, approvedAt?: string) {
  const handle = await runner.runWorkflow(
    reingest.spec,
    { orgId: org.id, workspaceId, key: await key() },
    {
      availableAt: new Date(Date.now() + 3_600_000),
      ...(approvedAt
        ? {
            idempotencyKey: `${upgradeJobId(workspaceId, await key())}:${approvedAt}`,
          }
        : {}),
    },
  )
  await runner.cancelWorkflowRun(handle.workflowRun.id)
  return handle.workflowRun.id
}

async function setWorkspace(
  workspaceId: string,
  fields: { formatVersion: number | null; desiredSha?: string | null },
) {
  await withOrgDbContext(org.id, (db) =>
    db.update(workspaces).set(fields).where(eq(workspaces.id, workspaceId)),
  )
}

const key = async () => reingestUpgradeKey((await readIngestSkillBundle()).name)
const row = async (workspaceId: string) =>
  withOrgIdContext(org, async () =>
    getWorkspaceUpgradeRow(workspaceId, await key()),
  )
const start = async (workspaceId: string) =>
  withOrgIdContext(org, async () =>
    startWorkspaceUpgrade({
      orgId: org.id,
      workspaceId,
      key: await key(),
      userId: "user_admin",
    }),
  )

/** The ingestion v2 runs that a re-ingestion started in this file (of one Workspace). */
async function reingestRuns(workspaceId = "") {
  const result = await getSystemDb().execute<{ id: string }>(sql`
    select id from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'repository-ingestion-v2'
      and idempotency_key like ${`upgrade-reingest:${org.id}:${workspaceId}%`}
  `)
  return result.rows.map((r) => r.id)
}

it(
  "offers the re-ingestion with an estimate, blocks it below format 3, and runs ingestion v2 once per click",
  { timeout: 420_000 },
  async () => {
    // No ingest sandbox runtime.
    vi.stubEnv("SANDBOX_PROVIDER", "vercel")
    await runScan()
    expect(await row(ready)).toMatchObject({
      status: "blocked",
      upgrade: { blockedReason: "sandbox_unavailable" },
    })
    vi.stubEnv("SANDBOX_PROVIDER", "docker")

    expect(await runScan()).toMatchObject({
      reingest: expect.arrayContaining([
        expect.objectContaining({
          workspaceId: ready,
          status: "awaiting_operator",
        }),
        expect.objectContaining({ workspaceId: behind, status: "blocked" }),
      ]),
    })
    const waiting = await row(ready)
    expect(waiting).toMatchObject({
      status: "awaiting_operator",
      upgrade: {
        targetFormat: 3,
        estimate: {
          repositories: 1,
          perRepository: [
            expect.objectContaining({
              repository: sourceName,
              basis: "heuristic",
            }),
          ],
        },
      },
    })
    const estimate = waiting?.upgrade.estimate
    expect(estimate?.costUsd.high).toBeGreaterThan(estimate?.costUsd.low ?? 0)
    expect(estimate?.minutes.high).toBeGreaterThan(estimate?.minutes.low ?? 0)
    expect(await row(behind)).toMatchObject({
      status: "blocked",
      upgrade: { blockedReason: "needs_format" },
    })
    // The scan starts nothing.
    expect(await reingestRuns()).toEqual([])
    expect(modelCalls).toEqual([])

    expect(await start(behind)).toMatchObject({ kind: "blocked" })
    // The runtime of this Workspace cannot report the model usage.
    noUsage.add(ready)
    expect(await start(ready)).toMatchObject({ kind: "queued" })
    expect(await start(ready)).toMatchObject({ kind: "existing" })

    const done = await settled(ready)
    expect(done).toMatchObject({
      status: "completed",
      upgrade: {
        approvedBy: "user_admin",
        repositories: [
          expect.objectContaining({
            repository: sourceName,
            status: "done",
            // The spend is unknown, not 0 with no note.
            spendUnknown: true,
            report: expect.arrayContaining([
              expect.stringContaining("Spend unknown"),
            ]),
          }),
        ],
      },
    })
    // One click, one ingestion v2 run, and its publish is on the default
    // branch of the Workspace.
    const runs = await reingestRuns()
    expect(runs).toHaveLength(1)
    expect(done?.upgrade.repositories?.[0]?.runId).toBe(runs[0])
    expect(modelCalls).toContain(ready)
    // `wide` also links the repository, but its operator approved nothing:
    // the run has no model step for it and no publish to it.
    expect(modelCalls).not.toContain(wide)
    expect(
      git(join(remotes, contexts[3] ?? ""), "ls-tree", "-r", "--name-only", "main"),
    ).not.toContain("knowledge/services/billing-api.md")
    expect(
      git(
        join(remotes, contexts[0] ?? ""),
        "show",
        "main:knowledge/services/billing-api.md",
      ),
    ).toContain("The billing-api service sends invoices.")

    // A click after the run starts nothing.
    expect(await start(ready)).toMatchObject({ kind: "completed" })
    await runScan()
    expect(await row(ready)).toMatchObject({ status: "completed" })
    expect(await reingestRuns()).toHaveLength(1)

    // The next estimate reads the finished run.
    const repositories = await workspaceSourceRepositories(org.id, ready)
    const next = await estimateReingest({
      orgId: org.id,
      repositories,
      bundleSkills: (await readIngestSkillBundle()).skills,
    })
    expect(next.perRepository).toEqual([
      expect.objectContaining({
        repository: sourceName,
        basis: "history",
        roots: { low: 1, high: 1 },
      }),
    ])
  },
)

it(
  "skips a repository that an earlier run did at the same commit, so a new start does not pay for it again",
  { timeout: 120_000 },
  async () => {
    const before = await row(ready)
    expect(before?.upgrade.repositories?.[0]).toMatchObject({ status: "done" })
    await setRow(ready, {
      to: "failed",
      failureReason: "An earlier run failed.",
    })
    expect(await start(ready)).toMatchObject({ kind: "queued" })
    expect(await settled(ready)).toMatchObject({
      status: "completed",
      upgrade: {
        repositories: [
          expect.objectContaining({
            repository: sourceName,
            status: "done",
            runId: before?.upgrade.repositories?.[0]?.runId,
            report: ["An earlier run did this commit."],
          }),
        ],
      },
    })
    expect(await reingestRuns(ready)).toHaveLength(1)
  },
)

it(
  "fails the re-ingestion when the ingestion run has no destination in the Workspace",
  { timeout: 420_000 },
  async () => {
    expect(await row(yamlOnly)).toMatchObject({ status: "awaiting_operator" })
    expect(await start(yamlOnly)).toMatchObject({ kind: "queued" })
    expect(await settled(yamlOnly)).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining(otherSource),
      upgrade: {
        repositories: [
          expect.objectContaining({
            repository: otherSource,
            status: "failed",
            report: expect.arrayContaining([
              expect.stringContaining("was not a destination"),
            ]),
          }),
        ],
      },
    })
    expect(await reingestRuns(yamlOnly)).toHaveLength(1)
    expect(modelCalls).not.toContain(yamlOnly)
  },
)

it(
  "stops the run when the model spend passes 2 times the p90 estimate",
  { timeout: 420_000 },
  async () => {
    // Each model step of this Workspace reports more than the whole cap.
    stepCostUsd.set(capped, 1_000)
    expect(await row(capped)).toMatchObject({ status: "awaiting_operator" })
    const high = (await row(capped))?.upgrade.estimate?.costUsd.high ?? 0
    expect(high * 2).toBeLessThan(1_000)
    expect(await start(capped)).toMatchObject({ kind: "queued" })
    const stopped = await settled(capped)
    expect(stopped).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("cost_cap"),
      upgrade: {
        stopReason: "cost_cap",
        repositories: [
          expect.objectContaining({
            repository: capSources[0],
            spendUsd: expect.any(Number),
          }),
          expect.objectContaining({
            repository: capSources[1],
            status: "failed",
            report: ["Not started: the re-ingestion stopped at the cost cap."],
          }),
        ],
      },
    })
    expect(
      stopped?.upgrade.repositories?.[0]?.spendUsd ?? 0,
    ).toBeGreaterThanOrEqual(1_000)
    // The second repository started no ingestion run.
    expect(await reingestRuns(capped)).toHaveLength(1)
  },
)

it(
  "refuses to start above the repositories that the step budget holds, with a clear reason",
  { timeout: 120_000 },
  async () => {
    expect(await row(wide)).toMatchObject({ status: "awaiting_operator" })
    const callsBefore = modelCalls.length
    expect(await start(wide)).toMatchObject({ kind: "queued" })
    expect(await settled(wide)).toMatchObject({
      status: "failed",
      failureReason: expect.stringMatching(
        /3 source repositories.*at most 2.*Remove some source repositories/,
      ),
    })
    // Nothing ran: no ingestion run and no model call.
    expect(await reingestRuns(wide)).toEqual([])
    expect(modelCalls).toHaveLength(callsBefore)
  },
)

it("keeps the row when the scan cannot read the format, or the format is newer than this code", async () => {
  expect(await row(capped)).toMatchObject({ status: "failed" })
  const [workspace] = await withOrgDbContext(org.id, (db) =>
    db.select().from(workspaces).where(eq(workspaces.id, capped)),
  )
  // No cached format and no commit: git cannot give the format file now.
  // Then a format that is newer than this code.
  for (const fields of [
    { formatVersion: null, desiredSha: null },
    { formatVersion: 4 },
  ]) {
    await setWorkspace(capped, fields)
    await runScan()
    expect(await row(capped)).toMatchObject({ status: "failed" })
    expect((await row(capped))?.upgrade.blockedReason).toBeUndefined()
  }
  await setWorkspace(capped, {
    formatVersion: 3,
    desiredSha: workspace?.desiredSha ?? null,
  })
})

it(
  "fails a re-ingestion row whose run ended in queued or in running, and a new start then works",
  { timeout: 420_000 },
  async () => {
    // Queued: the run of this click ended before it claimed the row.
    const approvedAt = new Date().toISOString()
    await endedUpgradeRun(capped, approvedAt)
    await setRow(capped, {
      to: "queued",
      upgrade: { approvedAt },
      workflowRunId: null,
    })
    await withOrgIdContext(org, () => failStoppedUpgradeRun(capped))
    expect(await row(capped)).toMatchObject({
      status: "failed",
      failureReason: "The upgrade run stopped before it finished.",
    })

    // Running: the recorded run ended without its result.
    await setRow(capped, {
      to: "running",
      workflowRunId: await endedUpgradeRun(capped),
    })
    await runScan()
    expect(await row(capped)).toMatchObject({
      status: "failed",
      failureReason: "The upgrade run stopped before it finished.",
    })

    stepCostUsd.delete(capped)
    // An earlier run did the first repository and spent more than the cap.
    // The new run skips it and does not count that spend again.
    const [first, ...rest] = (await row(capped))?.upgrade.repositories ?? []
    expect(first?.sha).toEqual(expect.any(String))
    await setRow(capped, {
      to: "failed",
      upgrade: {
        repositories: [
          {
            ...(first as NonNullable<typeof first>),
            status: "done",
            spendUsd: 1_000,
          },
          ...rest,
        ],
      },
    })
    expect(await start(capped)).toMatchObject({ kind: "queued" })
    expect(await settled(capped)).toMatchObject({
      status: "completed",
      upgrade: {
        repositories: [
          expect.objectContaining({ status: "done", spendUsd: 1_000 }),
          expect.objectContaining({ status: "done" }),
        ],
      },
    })
  },
)

it("deletes only the superseded rows of the same family", async () => {
  const insert = (key: string) =>
    insertWorkspaceUpgradeRow({
      workspaceId: behind,
      generation: 3,
      status: "awaiting_operator",
      upgrade: { key, fromFormat: 2, targetFormat: 3 },
    })
  const keys = async () =>
    (await listWorkspaceUpgradeRows(behind)).map((r) => r.upgrade.key).sort()
  await withOrgIdContext(org, async () => {
    const current = await key()
    await insert("format-3")
    await insert("reingest-ingest-older")
    // A re-ingestion scan keeps the format rows.
    await deleteSupersededUpgradeRows({
      workspaceId: behind,
      key: current,
      statuses: ["awaiting_operator", "blocked", "failed"],
    })
    expect(await keys()).toEqual(["format-3", current].sort())
    // A format scan keeps the re-ingestion rows.
    await deleteSupersededUpgradeRows({
      workspaceId: behind,
      key: "format-4",
      statuses: ["awaiting_operator", "blocked", "failed"],
    })
    expect(await keys()).toEqual([current])
  })
})
