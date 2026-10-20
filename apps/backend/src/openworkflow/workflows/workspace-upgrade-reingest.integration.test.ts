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
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { objects } from "../../db/schema/objects.js"
import {
  orgFirstWorkspaces,
  workspaces,
  workspaceWriteJobs,
} from "../../db/schema/workspaces.js"
import { readIngestSkillBundle } from "../../domain/ingestion/skill-bundle.js"
import { classifyUpgradeFailure } from "../../domain/upgrades/failure.js"
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
import { bootstrapWorkspaceFiles } from "../../domain/workspaces/bootstrap.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import { resolveWorkspaceReadRevision } from "../../domain/workspaces/resolve-revision.js"
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
import { listWorkspaceKnowledgeUnits } from "../../models/workspaces.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import { standInIngestShardRuntime } from "../../test/ingest-shard-stand-in.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { defineIngestionShardWorkflow } from "./ingestion-shard.js"
import { repositoryIndex } from "./repository-index.js"
import { defineRepositoryIngestionV2Workflow } from "./repository-ingestion-v2.js"
import { defineWorkspaceExtractIngestWorkflow } from "./workspace-extract-ingest.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
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
/** A source repository with no remote: no run can read it. */
const goneSource = `acme/gone-${suffix}`
const contexts = [`acme/context-a-${suffix}`, `acme/context-b-${suffix}`]
const costlySources = [`acme/costly-a-${suffix}`, `acme/costly-b-${suffix}`]
contexts.push(
  `acme/context-c-${suffix}`,
  `acme/context-d-${suffix}`,
  `acme/context-e-${suffix}`,
  `acme/context-f-${suffix}`,
)
contexts.push(`acme/context-g-${suffix}`, `acme/context-h-${suffix}`)
contexts.push(
  `acme/context-i-${suffix}`,
  `acme/context-j-${suffix}`,
  `acme/context-k-${suffix}`,
)
const [
  ready,
  behind,
  costly,
  wide,
  yamlOnly,
  overlay,
  flaky,
  denied,
  modelDown,
  requeued,
  unqueued,
] = [
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
  generateObjectId("ws"),
]
// The source repositories of each Workspace. `wide` also links the source
// of `ready`. `yamlOnly` links its repository only in
// `.ctxpipe/sources.yaml`, so ingestion v2 has no destination in it.
// `overlay` has main-era knowledge of its two source repositories.
const sourcesOf = [
  [sourceName],
  [otherSource],
  costlySources,
  [sourceName, otherSource, costlySources[0] ?? ""],
  [otherSource],
  [sourceName, goneSource],
  [otherSource],
  [goneSource],
  [otherSource],
  [otherSource],
  [otherSource],
]
/** The USD that each model step of a Workspace reports. */
const stepCostUsd = new Map<string, number>()
/** The Workspaces whose model steps report no usage, as a runtime that cannot. */
const noUsage = new Set<string>()
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
const modelCalls: string[] = []

/**
 * The file that a model step writes for a source repository. Each repository
 * has its own path: two repositories that write one path conflict when one
 * publish lands after the pin of the other run, and the conflict calls the
 * merge model, which has no key in this file.
 */
function modelFile(repository: string) {
  const name = (repository.split("/").pop() ?? "")
    .replace(/\.git$/, "")
    .replace(`-${suffix}`, "")
  return {
    path: `knowledge/services/${name}.md`,
    content: `---\nkind: Service\nname: ${name}\n---\n# ${name}\n\nThe ${name} service sends invoices.\n`,
  }
}

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => "fixture-only-github-token"),
  // The write check of a hydrate (after a publish): the app can push.
  http.get("https://api.github.com/repos/:owner/:repo", ({ params }) =>
    HttpResponse.json({
      full_name: `${params.owner}/${params.repo}`,
      default_branch: "main",
      permissions: { push: true },
    }),
  ),
  http.post(MODEL_URL, async ({ request }) => {
    const body = (await request.json()) as {
      workspaceId: string
      args: string[]
    }
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
        modelFile(body.args[body.args.indexOf("--source-url") + 1] ?? ""),
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
  // The first costly source is a small monorepo with three roots.
  remote(costlySources[0] ?? "", {
    "package.json": '{ "name": "cap" }\n',
    // The workspace manifest names the roots, so no model chooses a root.
    "pnpm-workspace.yaml": 'packages:\n  - "."\n  - packages/*\n',
    "packages/a/package.json": '{ "name": "a" }\n',
    "packages/b/package.json": '{ "name": "b" }\n',
  })
  remote(costlySources[1] ?? "", { "package.json": '{ "name": "cap" }\n' })
  // The tree of each Workspace has the format of its row: ingestion v2
  // reads the format at the pinned commit before it publishes (G5).
  // Each source file is in the tree too: the publish checks it.
  const pinned = contexts.map((name, i) => {
    const format = workspaceFormatFile(i === 1 ? 2 : 3)
    return remote(name, {
      "README.md": "# Context\n",
      [format.path]: format.content,
      // A hydrate runs on `overlay`: its bootstrap files are current, so
      // hydrate queues no bootstrap write.
      ...(i === 5
        ? Object.fromEntries(
            bootstrapWorkspaceFiles({
              displayName: "Re-ingest 5",
              existing: new Map(),
            }).map((file) => [file.path, file.content]),
          )
        : {}),
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
  // `ready`, `costly`, `wide` and `yamlOnly` are at format 3. `wide` has
  // more source repositories than the step budget of this file holds.
  // `behind` is at format 2, so it must merge the format upgrade first (G5).
  for (const [i, workspaceId] of [
    ready,
    behind,
    costly,
    wide,
    yamlOnly,
    overlay,
    flaky,
    denied,
    modelDown,
    requeued,
    unqueued,
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
      git(
        join(remotes, contexts[3] ?? ""),
        "ls-tree",
        "-r",
        "--name-only",
        "main",
      ),
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
    const failed = await settled(yamlOnly)
    expect(failed).toMatchObject({
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
    // A Workspace that is not a destination stays so: no automatic retry.
    expect(failed?.upgrade.autoRetry).toBeUndefined()
    expect(
      classifyUpgradeFailure({
        status: failed?.status ?? "",
        failureReason: failed?.failureReason ?? null,
        repositories: failed?.upgrade.repositories,
      }),
    ).toMatchObject({ code: "unknown", repository: otherSource })
    expect(await reingestRuns(yamlOnly)).toHaveLength(1)
    expect(modelCalls).not.toContain(yamlOnly)
  },
)

it(
  "runs every model step when the spend is high, publishes all of it, and records the spend",
  { timeout: 420_000 },
  async () => {
    // Each model step reports $50. The first repository has three roots
    // and the second one root, so the run spends $200. The product records
    // spend and does not cap it (ADR-052): each step runs.
    stepCostUsd.set(costly, 50)
    expect(await row(costly)).toMatchObject({ status: "awaiting_operator" })
    const callsBefore = modelCalls.filter((id) => id === costly).length
    expect(await start(costly)).toMatchObject({ kind: "queued" })
    const finished = await settled(costly)
    expect(finished).toMatchObject({
      status: "completed",
      upgrade: {
        repositories: [
          expect.objectContaining({
            repository: costlySources[0],
            status: "done",
            spendUsd: 150,
          }),
          expect.objectContaining({
            repository: costlySources[1],
            status: "done",
            spendUsd: 50,
          }),
        ],
      },
    })
    expect(modelCalls.filter((id) => id === costly).length - callsBefore).toBe(
      4,
    )
    expect(
      git(
        join(remotes, contexts[2] ?? ""),
        "show",
        `main:${modelFile(costlySources[0] ?? "").path}`,
      ),
    ).toContain("The costly-a service sends invoices.")
    stepCostUsd.delete(costly)
    const [first, second] = finished?.upgrade.repositories ?? []

    // The later tests of this file start from a failed row whose second
    // repository did not run.
    await setRow(costly, {
      to: "failed",
      failureReason: "The re-ingestion stopped.",
      upgrade: {
        repositories: [
          first as NonNullable<typeof first>,
          {
            ...(second as NonNullable<typeof second>),
            status: "failed",
            report: ["Not started."],
          },
        ],
      },
    })
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
  expect(await row(costly)).toMatchObject({ status: "failed" })
  const [workspace] = await withOrgDbContext(org.id, (db) =>
    db.select().from(workspaces).where(eq(workspaces.id, costly)),
  )
  // No cached format and no commit: git cannot give the format file now.
  // Then a format that is newer than this code.
  for (const fields of [
    { formatVersion: null, desiredSha: null },
    { formatVersion: 4 },
  ]) {
    await setWorkspace(costly, fields)
    await runScan()
    expect(await row(costly)).toMatchObject({ status: "failed" })
    expect((await row(costly))?.upgrade.blockedReason).toBeUndefined()
  }
  await setWorkspace(costly, {
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
    await endedUpgradeRun(costly, approvedAt)
    await setRow(costly, {
      to: "queued",
      upgrade: { approvedAt },
      workflowRunId: null,
    })
    await withOrgIdContext(org, () => failStoppedUpgradeRun(costly))
    expect(await row(costly)).toMatchObject({
      status: "failed",
      failureReason: "The upgrade run stopped before it finished.",
    })

    // Running: the recorded run ended without its result.
    await setRow(costly, {
      to: "running",
      workflowRunId: await endedUpgradeRun(costly),
    })
    await runScan()
    expect(await row(costly)).toMatchObject({
      status: "failed",
      failureReason: "The upgrade run stopped before it finished.",
    })

    stepCostUsd.delete(costly)
    // An earlier run did the first repository and spent a lot. The new
    // run skips it and keeps that spend in the report.
    const [first, ...rest] = (await row(costly))?.upgrade.repositories ?? []
    expect(first?.sha).toEqual(expect.any(String))
    await setRow(costly, {
      to: "failed",
      upgrade: {
        repositories: [
          {
            ...(first as NonNullable<typeof first>),
            status: "done",
            spendUsd: 1_000,
          },
          // An earlier run of the second repository reported its spend as
          // incomplete: a retry does not show a complete-looking spend.
          ...rest.map((r, index) =>
            index === 0 ? { ...r, spendUsd: 5, spendUnknown: true } : r,
          ),
        ],
      },
    })
    // A publish of the first repository can land after the pin of the new
    // run: the time limit can cancel that run after its push. Force that
    // order: the new run publishes on a default branch that moved.
    const work = mkdtempSync(join(folder, "late-"))
    git(work, "clone", "-q", join(remotes, contexts[2] ?? ""), ".")
    const late = modelFile(costlySources[0] ?? "")
    mkdirSync(dirname(join(work, late.path)), { recursive: true })
    writeFileSync(join(work, late.path), late.content)
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "A late publish of the first repository")
    git(work, "push", "-q", "origin", "HEAD:main")
    expect(await start(costly)).toMatchObject({ kind: "queued" })
    expect(await settled(costly)).toMatchObject({
      status: "completed",
      upgrade: {
        repositories: [
          expect.objectContaining({ status: "done", spendUsd: 1_000 }),
          expect.objectContaining({ status: "done", spendUnknown: true }),
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

/*
 * Main-era knowledge stays in the projection until the re-ingestion did its
 * repository. This test runs the real hydrate, so it comes last: a hydrate
 * replaces the source rows of a Workspace from its tree.
 */
it(
  "drops the main-era knowledge of each repository that the re-ingestion did, and keeps the others",
  { timeout: 420_000 },
  async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://reingest-embeddings.test/v1")
    server.use(
      // Hydrate checks that ctx| can write to the Workspace repository.
      http.get(`https://api.github.com/repos/${contexts[5]}`, () =>
        HttpResponse.json({
          id: 7_000,
          full_name: contexts[5],
          default_branch: "main",
          permissions: { push: true },
        }),
      ),
      http.post(
        "https://reingest-embeddings.test/v1/embeddings",
        async ({ request }) => {
          const body = (await request.json()) as { input: string[] }
          return HttpResponse.json({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array(2000).fill(0.01),
            })),
          })
        },
      ),
    )
    // The worker gets the hydrate workflow.
    await worker.stop()
    runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
    // The source repository now has an org repository row, so ingestion v2
    // indexes it first. Codesearch is not in this test: the index is a
    // stand-in that does nothing.
    runner.implementWorkflow(
      repositoryIndex.spec,
      (async () => null) as unknown as typeof repositoryIndex.fn,
    )
    worker = runner.newWorker({ concurrency: 4 })
    await worker.start()

    // A main-era org: `overlay` is its first Workspace, and each source
    // repository has an object in Postgres.
    await withOrgIdContext(org, async () => {
      for (const [repository, name] of [
        // Not the path of the file that the re-ingestion writes, so that
        // only the done mark can drop it.
        [sourceName, "Billing worker"],
        [goneSource, "Gone service"],
      ] as const) {
        const row = await ensureOrgRepositoryForGitUrl({
          orgId: org.id,
          gitUrl: `https://github.com/${repository}.git`,
        })
        if (!row) throw new Error("No org repository was created")
        if (repository === sourceName)
          await withOrgDbContext(org.id, (db) =>
            db
              .insert(orgFirstWorkspaces)
              .values({
                orgId: org.id,
                workspaceId: overlay,
                sourceRepositoryId: row.id,
              })
              // An earlier test of this file set the first Workspace.
              .onConflictDoUpdate({
                target: orgFirstWorkspaces.orgId,
                set: { workspaceId: overlay, sourceRepositoryId: row.id },
              }),
          )
        await withOrgDbContext(org.id, (db) =>
          db.insert(objects).values({
            id: generateObjectId("obj"),
            orgId: org.id,
            kind: "Service",
            deduplicationKey: `svc:${row.id}:${name}`,
            payload: { name, summary: `The ${name}.` },
          }),
        )
      }
    })
    const legacyPaths = () =>
      withOrgIdContext(org, async () =>
        (await listWorkspaceKnowledgeUnits(overlay)).units
          .filter((unit) => unit.source === "legacy")
          .map((unit) => unit.path)
          .sort(),
      )
    try {
      const revision = await withOrgIdContext(org, () =>
        resolveWorkspaceReadRevision({
          orgId: org.id,
          workspaceId: overlay,
          env: parseEnv(process.env),
        }),
      )
      if (!revision) throw new Error("The overlay Workspace has no revision")
      const first = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId: overlay,
        revision: revision.revision,
      })
      expect(await first.result({ timeoutMs: 120_000 })).toMatchObject({
        hydrated: true,
      })
      expect(await legacyPaths()).toEqual([
        "knowledge/services/billing-worker.md",
        "knowledge/services/gone-service.md",
      ])

      // The run does the readable repository; it cannot read the other.
      await runScan()
      expect(await start(overlay)).toMatchObject({ kind: "queued" })
      expect(await settled(overlay)).toMatchObject({
        status: "failed",
        upgrade: {
          repositories: [
            expect.objectContaining({ repository: sourceName, status: "done" }),
            expect.objectContaining({
              repository: goneSource,
              status: "failed",
            }),
          ],
        },
      })
      // The run queued a hydrate that drops the overlay of the done
      // repository. The overlay of the other repository stays.
      await expect
        .poll(legacyPaths, { timeout: 120_000, interval: 1_000 })
        .toEqual(["knowledge/services/gone-service.md"])
      // Only the step in which the repository became done queued it. The
      // later record steps changed no done mark.
      const reprojects = (
        await backend.listWorkflowRuns({ limit: 1_000 })
      ).data.filter((workflowRun) => {
        const queued = workflowRun.input as {
          workspaceId?: string
          reproject?: boolean
        } | null
        return (
          workflowRun.workflowName === "workspace-hydrate" &&
          queued?.workspaceId === overlay &&
          queued.reproject === true
        )
      })
      expect(reprojects).toHaveLength(1)
    } finally {
      await withOrgDbContext(org.id, (db) =>
        db.delete(objects).where(eq(objects.orgId, org.id)),
      )
    }
  },
)

it(
  "retries once by itself when a run fails for a temporary cause, and completes",
  { timeout: 420_000 },
  async () => {
    // Another publish of the same file lands on the default branch of the
    // Workspace after the run pinned it and before the run publishes. The
    // merge needs a model, which this file does not give, so the run fails
    // with a publish conflict, a temporary cause. The retry pins the new
    // default branch, so it has nothing to merge.
    let landed = false
    server.use(
      http.post(MODEL_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { workspaceId: string }
        if (body.workspaceId !== flaky || landed) return undefined
        landed = true
        const work = mkdtempSync(join(folder, "other-publish-"))
        git(work, "clone", "-q", join(remotes, contexts[6] ?? ""), ".")
        const other = modelFile(otherSource)
        mkdirSync(dirname(join(work, other.path)), { recursive: true })
        writeFileSync(
          join(work, other.path),
          "---\nkind: Service\nname: ledger\n---\n# ledger\n\nAn older text.\n",
        )
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "Another publish of the same file")
        git(work, "push", "-q", "origin", "HEAD:main")
        return undefined
      }),
    )
    expect(await row(flaky)).toMatchObject({ status: "awaiting_operator" })
    expect(await start(flaky)).toMatchObject({ kind: "queued" })
    const done = await settled(flaky)
    expect(done).toMatchObject({
      status: "completed",
      upgrade: {
        approvedBy: "user_admin",
        autoRetry: { failedRunId: expect.any(String) },
        repositories: [
          expect.objectContaining({ repository: otherSource, status: "done" }),
        ],
      },
    })
    // The failed run and the retry each started one ingestion run, and the
    // retry is a different upgrade run.
    expect(await reingestRuns(flaky)).toHaveLength(2)
    expect(done?.upgrade.autoRetry?.failedRunId).not.toBe(done?.workflowRunId)
  },
)

it(
  "fails at once, with no retry, when the cause is not temporary, and a start by the user clears the record",
  { timeout: 420_000 },
  async () => {
    // The source repository has no remote: ctx| cannot read it, which a
    // second run cannot change.
    expect(await row(denied)).toMatchObject({ status: "awaiting_operator" })
    expect(await start(denied)).toMatchObject({ kind: "queued" })
    const failed = await settled(denied)
    expect(failed).toMatchObject({
      status: "failed",
      upgrade: {
        repositories: [
          expect.objectContaining({ repository: goneSource, status: "failed" }),
        ],
      },
    })
    expect(failed?.upgrade.autoRetry).toBeUndefined()
    expect(
      classifyUpgradeFailure({
        status: failed?.status ?? "",
        failureReason: failed?.failureReason ?? null,
        repositories: failed?.upgrade.repositories,
      }),
    ).toMatchObject({ code: "source_access", repository: goneSource })
    expect(await reingestRuns(denied)).toEqual([])

    // A start by the user removes the record of an earlier automatic retry.
    await setRow(denied, {
      to: "failed",
      failureReason: "The re-ingestion did not finish.",
      upgrade: {
        autoRetry: { failedRunId: "run_earlier" },
      },
    })
    expect(await row(denied)).toMatchObject({
      upgrade: { autoRetry: { failedRunId: "run_earlier" } },
    })
    const queued = await start(denied)
    expect(queued).toMatchObject({ kind: "queued" })
    expect(
      (await row(denied))?.upgrade.autoRetry,
      "the start by the user removes the record",
    ).toBeUndefined()
    expect(await settled(denied)).toMatchObject({ status: "failed" })
  },
)

/**
 * A model provider that is down for each model call of the Workspace while
 * the first upgrade run owns the row. `onFirstCall` runs once, at the first
 * call, with that run.
 */
function modelDownForFirstRun(
  workspaceId: string,
  onFirstCall?: (upgradeRunId: string) => Promise<void>,
) {
  let firstRun: string | null = null
  server.use(
    http.post(MODEL_URL, async ({ request }) => {
      const body = (await request.clone().json()) as { workspaceId: string }
      if (body.workspaceId !== workspaceId) return undefined
      const owner = (await row(workspaceId))?.workflowRunId ?? ""
      if (firstRun === null) {
        firstRun = owner
        await onFirstCall?.(owner)
      }
      if (owner !== firstRun) return undefined
      return HttpResponse.json({ error: "overloaded" }, { status: 503 })
    }),
  )
}

/** The step failures of each ingestion v2 run of the Workspace, oldest first. */
async function stepFailuresOfRuns(workspaceId: string) {
  const result = await getSystemDb().execute<{
    output: { workspaces?: Array<{ stepFailures?: object }> } | null
  }>(sql`
    select output from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'repository-ingestion-v2'
      and idempotency_key like ${`upgrade-reingest:${org.id}:${workspaceId}%`}
    order by created_at
  `)
  return result.rows.map((r) => r.output?.workspaces?.[0]?.stepFailures)
}

it(
  "starts the run again by itself, once, when a model step fails after its attempts, and completes",
  { timeout: 420_000 },
  async () => {
    // The model provider is down for the first run only, as an outage that
    // ends.
    modelDownForFirstRun(modelDown)
    expect(await row(modelDown)).toMatchObject({ status: "awaiting_operator" })
    expect(await start(modelDown)).toMatchObject({ kind: "queued" })
    const done = await settled(modelDown)
    expect(done).toMatchObject({
      status: "completed",
      upgrade: {
        autoRetry: { failedRunId: expect.any(String) },
        repositories: [
          expect.objectContaining({ repository: otherSource, status: "done" }),
        ],
      },
    })
    expect(done?.upgrade.autoRetry?.failedRunId).not.toBe(done?.workflowRunId)
    // The first ingestion run counted the failed model step. The retry had
    // no failed step.
    expect(await stepFailuresOfRuns(modelDown)).toEqual([
      { model: expect.any(Number) },
      undefined,
    ])
  },
)

it(
  "queues the retry run when an earlier attempt of the failure step queued the row but not the run",
  { timeout: 420_000 },
  async () => {
    // At the first model call, the row is as an attempt of the failure step
    // left it when it stopped before the enqueue: queued again after this
    // run, with the approval of the retry, and no retry run.
    const approvedAt = "2026-01-02T03:04:05.000Z"
    modelDownForFirstRun(requeued, (upgradeRunId) =>
      setRow(requeued, {
        to: "queued",
        upgrade: { approvedAt, autoRetry: { failedRunId: upgradeRunId } },
      }),
    )
    expect(await row(requeued)).toMatchObject({ status: "awaiting_operator" })
    expect(await start(requeued)).toMatchObject({ kind: "queued" })
    // A failure step that did not take the re-entry path leaves the row
    // `queued` with no run, so it does not complete.
    const done = await settled(requeued)
    expect(done).toMatchObject({
      status: "completed",
      upgrade: { approvedAt, autoRetry: { failedRunId: expect.any(String) } },
    })
    expect(done?.upgrade.autoRetry?.failedRunId).not.toBe(done?.workflowRunId)
    expect(await reingestRuns(requeued)).toHaveLength(2)
  },
)

it(
  "fails the row, and keeps no queued row, when ctx| cannot queue the retry",
  { timeout: 420_000 },
  async () => {
    server.use(
      http.post(MODEL_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { workspaceId: string }
        if (body.workspaceId !== unqueued) return undefined
        return HttpResponse.json({ error: "overloaded" }, { status: 503 })
      }),
    )
    // Postgres refuses the second upgrade run of the Workspace: the retry.
    // A sequence is not transactional, so the count stays.
    const { Pool } = await import("pg")
    const { ownerUrlForMigrate } = await import("../../db/owner-migrate-url.js")
    const owner = new Pool({
      connectionString: ownerUrlForMigrate(process.env.DATABASE_URL ?? ""),
    })
    const fault = `ctx896_fault_${suffix}`
    await owner.query(`
      create sequence public.${fault}_seq;
      create function public.${fault}() returns trigger
      language plpgsql as $$
      begin
        if new.workflow_name = 'workspace-upgrade-reingest'
          and new.input->>'workspaceId' = '${unqueued}'
          and nextval('public.${fault}_seq') = 2 then
          raise exception 'The workflow queue is unavailable';
        end if;
        return new;
      end $$;
      create trigger ${fault} before insert on openworkflow.workflow_runs
        for each row execute function public.${fault}();
    `)
    let failed: Awaited<ReturnType<typeof row>> | undefined
    try {
      expect(await row(unqueued)).toMatchObject({
        status: "awaiting_operator",
      })
      expect(await start(unqueued)).toMatchObject({ kind: "queued" })
      failed = await settled(unqueued)
    } finally {
      await owner.query(`
        drop trigger ${fault} on openworkflow.workflow_runs;
        drop function public.${fault}();
        drop sequence public.${fault}_seq;
      `)
      await owner.end()
    }
    expect(failed).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining(otherSource),
      upgrade: {
        repositories: [
          expect.objectContaining({
            repository: otherSource,
            status: "partial",
            report: expect.arrayContaining([
              expect.stringMatching(
                /^\d+ ingest steps? failed after 3 attempts\. The model returned an error\.$/,
              ),
            ]),
          }),
        ],
      },
    })
    // The retry did not start, so the card does not say that it did.
    expect(failed?.upgrade.autoRetry).toBeUndefined()
    expect(
      classifyUpgradeFailure({
        status: failed?.status ?? "",
        failureReason: failed?.failureReason ?? null,
        repositories: failed?.upgrade.repositories,
      }),
    ).toMatchObject({ code: "model", repository: otherSource })
    expect(await reingestRuns(unqueued)).toHaveLength(1)
  },
)
