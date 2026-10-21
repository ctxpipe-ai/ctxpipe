import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import { describe, expect, it } from "vitest"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { WRITE_STATUS_REASONS } from "../../domain/workspaces/write-status.js"
import { GIT_REMOTE_ACCESS_MESSAGES } from "../../services/git/clone-tree.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"

it(
  "cron queues no knowledge export for a writable Workspace that has none (ADR-053: only the upgrade pull request writes it)",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
          updated: 0,
          linkedUpdated: 0,
        })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        try {
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { workspaceId?: string })?.workspaceId ===
                f.workspaceId &&
              run.workflowName === "workspace-write-migration-export",
          )
          expect(queued).toEqual([])
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "cron resumes a paused write job through the native workflow queue, but never a direct knowledge export",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const jobId = `wjob_${f.id}`
        const exportJobId = `wjob_${f.id}_export`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceWriteJobs).values(
            (["claims_upgrade", "migration_export"] as const).map((kind) => ({
              id: kind === "claims_upgrade" ? jobId : exportJobId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              kind,
              generation: 1,
              desiredSha: f.sha,
              status: "paused",
              payload: { jobWorkspaceUrl: f.workspaceUrl },
            })),
          ),
        )
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await handle.result({ timeoutMs: 30_000 })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        try {
          const runs = (await backend.listWorkflowRuns({ limit: 100 })).data
          expect(
            runs.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toEqual([
            expect.objectContaining({
              workflowName: "workspace-write-claims-upgrade",
              input: expect.objectContaining({
                jobId,
                revision: expect.objectContaining({
                  sha: f.sha,
                  access: "write-default",
                }),
              }),
            }),
          ])
          // The export goes only through the upgrade pull request
          // (ADR-053): the tip check neither resumes an old paused export
          // nor queues a new one.
          expect(
            runs.filter(
              (run) => run.workflowName === "workspace-write-migration-export",
            ),
          ).toEqual([])
          const exportRow = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ status: workspaceWriteJobs.status })
              .from(workspaceWriteJobs)
              .where(eq(workspaceWriteJobs.id, exportJobId)),
          )
          expect(exportRow).toEqual([{ status: "paused" }])
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "cron records read-only access after the repository leaves its installation",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "missing",
        writeStatus: "writable",
        // Format 3: hydrate plans a write, so the cron checks write access.
        format: 3,
      },
      async (f) => {
        await f.publish()
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await handle.result({ timeoutMs: 30_000 })
        const [row] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({
              writeStatus: workspaces.writeStatus,
              readOnlyReason: workspaces.readOnlyReason,
            })
            .from(workspaces)
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(row).toEqual({
          writeStatus: "read_only",
          readOnlyReason:
            "This repository is not in the GitHub App installation. An installation owner or admin must add it, then refresh.",
        })
      },
    )
  },
)

/** Merge a sources file into the Workspace remote, as a merged PR does. */
function pushSourcesFile(f: NativeHydrationFixture): string {
  mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
  writeFileSync(
    join(f.directory, ".ctxpipe/sources.yaml"),
    [
      "version: 1",
      "sources:",
      "  - id: issues",
      "    provider: linear",
      "    connection: con_elsewhere",
      "    teams: [ENG]",
      "",
    ].join("\n"),
  )
  f.git("add", ".ctxpipe/sources.yaml")
  f.git(
    "-c",
    "user.name=Human",
    "-c",
    "user.email=human@example.test",
    "commit",
    "-m",
    "Add the Linear source",
  )
  f.git("push", f.remote, "HEAD:refs/heads/main")
  return f.git("rev-parse", "HEAD")
}

it(
  "cron hydrates a moved Workspace when GitHub cannot find the repository of another Workspace",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        // A second Workspace on the same connection. Its repository was
        // deleted, so GitHub refuses a token for it.
        const goneId = `ws_gone_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaces).values({
            id: goneId,
            orgId: f.org.id,
            slug: "gone",
            displayName: "Gone",
            workspaceRepositoryUrl:
              "https://github.com/fixture/deleted-repo.git",
            githubConnectionId: f.connectionId,
            desiredDefaultBranch: "main",
          }),
        )
        f.server.use(
          http.post(
            "https://api.github.com/app/installations/123456789/access_tokens",
            async ({ request }) => {
              const body = await request.clone().text()
              const names = (body ? JSON.parse(body) : {}).repositories
              if (!names?.includes("deleted-repo")) return undefined
              return HttpResponse.json(
                {
                  message:
                    "There is at least one repository that does not exist or is not accessible to the parent installation.",
                },
                { status: 422 },
              )
            },
          ),
        )
        const sha = pushSourcesFile(f)

        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
          updated: 1,
        })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        try {
          const hydrates = (
            await backend.listWorkflowRuns({ limit: 1000 })
          ).data.filter((run) => {
            const input = run.input as {
              workspaceId?: string
              revision?: { sha?: string }
            }
            return (
              run.workflowName === "workspace-hydrate" &&
              input?.workspaceId === f.workspaceId &&
              input.revision?.sha === sha
            )
          })
          expect(hydrates).toHaveLength(1)
        } finally {
          await backend.stop()
        }
        const [gone] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({
              hydrateStatus: workspaces.hydrateStatus,
              hydrateError: workspaces.hydrateError,
            })
            .from(workspaces)
            .where(eq(workspaces.id, goneId)),
        )
        expect(gone).toEqual({
          hydrateStatus: "failed",
          hydrateError: GIT_REMOTE_ACCESS_MESSAGES.denied,
        })
      },
    )
  },
)

/** The hydrate runs that the tip check queued for one Workspace tip. */
async function tipHydrateRuns(f: NativeHydrationFixture, sha: string) {
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  try {
    return (await backend.listWorkflowRuns({ limit: 1000 })).data.filter(
      (run) => {
        const input = run.input as {
          workspaceId?: string
          revision?: { sha?: string }
        }
        return (
          run.workflowName === "workspace-hydrate" &&
          input?.workspaceId === f.workspaceId &&
          input.revision?.sha === sha
        )
      },
    )
  } finally {
    await backend.stop()
  }
}

/** Run one tip check. `hour` fixes the UTC hour that its retry keys hold. */
async function runTipCheck(f: NativeHydrationFixture, hour?: string) {
  const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
    orgId: f.org.id,
    ...(hour ? { hour } : {}),
  })
  return handle.result({ timeoutMs: 30_000 })
}

it(
  "cron hydrates a tip that an earlier failed run stored but did not queue",
  { timeout: 90_000 },
  async () => {
    // Writable, with no completed migration export: the export-gated cron
    // fallback does not apply.
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)
        // The failed run stored the tip in `desired_sha`, then stopped.
        expect((await f.resolveRevision(true)).sha).toBe(sha)

        expect(await runTipCheck(f)).toMatchObject({ updated: 0 })
        expect(await tipHydrateRuns(f, sha)).toHaveLength(1)
      },
    )
  },
)

it(
  "cron queues one hydrate for a read-only Workspace tip across runs during an in-flight hydrate",
  { timeout: 90_000 },
  async () => {
    // Read-only skips the export wait, so the earlier fallback queued a
    // hydrate on each run while the Workspace was building.
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)

        expect(await runTipCheck(f)).toMatchObject({ updated: 1 })
        // No worker serves this queue, so the hydrate stays pending.
        expect(await tipHydrateRuns(f, sha)).toEqual([
          expect.objectContaining({ status: "pending" }),
        ])
        expect(await runTipCheck(f)).toMatchObject({ updated: 0 })
        expect(await tipHydrateRuns(f, sha)).toHaveLength(1)
      },
    )
  },
)

it(
  "cron queues a failed hydrate of the tip again in the next hour, not before",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)
        // The key holds the UTC hour. Each check gets its hour, so the
        // result does not depend on the clock.
        await runTipCheck(f, "2026-01-01T09")
        const [first] = await tipHydrateRuns(f, sha)
        if (!first?.idempotencyKey) throw new Error("Expected a keyed hydrate")
        expect(first.idempotencyKey.endsWith(":2026-01-01T09")).toBe(true)
        await getSystemDb().execute(
          sql`update openworkflow.workflow_runs set status = 'failed', finished_at = now() where id = ${first.id}`,
        )

        await runTipCheck(f, "2026-01-01T09")
        expect(await tipHydrateRuns(f, sha)).toHaveLength(1)

        await runTipCheck(f, "2026-01-01T10")
        expect(
          (await tipHydrateRuns(f, sha)).map((run) => run.status).sort(),
        ).toEqual(["failed", "pending"])
      },
    )
  },
)

it(
  "cron queues a hydrate again when the unfinished one is older than 3 hours",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)
        await runTipCheck(f)
        const [stuck] = await tipHydrateRuns(f, sha)
        if (!stuck?.idempotencyKey) throw new Error("Expected a keyed hydrate")
        // The run stays pending, as if it started 4 hours ago, with the key
        // of that hour.
        const earlier = new Date(Date.now() - 4 * 3_600_000)
        await getSystemDb().execute(
          sql`update openworkflow.workflow_runs set created_at = ${earlier.toISOString()}::timestamptz, idempotency_key = ${`${stuck.idempotencyKey.slice(0, -13)}${earlier.toISOString().slice(0, 13)}`} where id = ${stuck.id}`,
        )
        await runTipCheck(f)
        expect((await tipHydrateRuns(f, sha)).map((run) => run.status)).toEqual(
          ["pending", "pending"],
        )
      },
    )
  },
)

it(
  "cron records no access on a ready Workspace that loses its credential, then backs off",
  { timeout: 90_000 },
  async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address")
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL
    try {
      await withNativeHydrationFixture({}, async (f) => {
        await f.publish()
        // The Workspace URL stays the same; only the remote starts to refuse reads.
        const gitConfig = join(
          await mkdtemp(join(tmpdir(), "ctxpipe-no-access-")),
          "gitconfig",
        )
        await promisify(execFile)("git", [
          "config",
          "--file",
          gitConfig,
          `url.http://127.0.0.1:${address.port}/private.git.insteadOf`,
          f.workspaceUrl,
        ])
        process.env.GIT_CONFIG_GLOBAL = gitConfig
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const hydrateRuns = async () =>
          (await backend.listWorkflowRuns({ limit: 1000 })).data.filter(
            (run) =>
              run.workflowName === "workspace-hydrate" &&
              (run.input as { workspaceId?: string })?.workspaceId ===
                f.workspaceId,
          ).length
        try {
          const hydratesBefore = await hydrateRuns()
          const first = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          expect(await first.result({ timeoutMs: 30_000 })).toEqual({
            updated: 0,
            linkedUpdated: 0,
          })
          const [row] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({
                hydrateStatus: workspaces.hydrateStatus,
                hydrateError: workspaces.hydrateError,
              })
              .from(workspaces)
              .where(eq(workspaces.id, f.workspaceId)),
          )
          expect(row).toEqual({
            hydrateStatus: "failed",
            hydrateError:
              "ctxpipe has no access to this repository. Connect GitHub to this Workspace, then retry.",
          })
          const requestsAfterFirst = requests
          expect(requestsAfterFirst).toBeGreaterThan(0)
          const second = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await second.result({ timeoutMs: 30_000 })
          expect(requests).toBe(requestsAfterFirst)
          expect(await hydrateRuns()).toBe(hydratesBefore)
        } finally {
          await backend.stop()
        }
      })
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)

describe("cron write probe on a GitHub error", () => {
  it.each([
    {
      name: "a server error",
      response: () =>
        HttpResponse.json({ message: "Server Error" }, { status: 502 }),
    },
    {
      name: "a primary rate limit (403)",
      response: () =>
        HttpResponse.json(
          { message: "API rate limit exceeded for installation ID 1." },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
    },
    {
      name: "a secondary rate limit (429)",
      response: () =>
        HttpResponse.json(
          { message: "You have exceeded a secondary rate limit." },
          { status: 429, headers: { "retry-after": "1" } },
        ),
      // One try, then one wait of `retry-after`. No backoff on top of it.
      requests: 2,
    },
  ])(
    "records that it could not check write access after $name",
    { timeout: 60_000 },
    async ({ response, requests }) => {
      await withNativeHydrationFixture(
        { github: true, githubWriteView: "writable" },
        async (f) => {
          await f.publish()
          let githubRequests = 0
          f.server.use(
            http.get("https://api.github.com/repos/fixture/:repo", () => {
              githubRequests += 1
              return response()
            }),
          )
          const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await handle.result({ timeoutMs: 30_000 })
          const [row] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({
                writeStatus: workspaces.writeStatus,
                readOnlyReason: workspaces.readOnlyReason,
              })
              .from(workspaces)
              .where(eq(workspaces.id, f.workspaceId)),
          )
          // A definite state: the UI stops its poll and shows the reason.
          expect(row).toEqual({
            writeStatus: "unknown",
            readOnlyReason: WRITE_STATUS_REASONS.checkFailed,
          })
          if (requests !== undefined) expect(githubRequests).toBe(requests)
        },
      )
    },
  )
})

/** The runs of one workflow whose input names this Workspace. */
async function workspaceRuns(f: NativeHydrationFixture, workflowName: string) {
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  try {
    return (await backend.listWorkflowRuns({ limit: 1000 })).data.filter(
      (run) => {
        const input = run.input as {
          workspaceId?: string
          revision?: { workspaceId?: string }
        }
        return (
          run.workflowName === workflowName &&
          (input?.workspaceId ?? input?.revision?.workspaceId) === f.workspaceId
        )
      },
    )
  } finally {
    await backend.stop()
  }
}

/** Make the write jobs of the fixture Workspace two hours old. */
async function ageWriteJobs(f: NativeHydrationFixture) {
  await withOrgDbContext(f.org.id, (db) =>
    db
      .update(workspaceWriteJobs)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        updatedAt: sql`now() - interval '2 hours'`,
      })
      .where(eq(workspaceWriteJobs.workspaceId, f.workspaceId)),
  )
}

it(
  "cron queues a stale write job again when the process stopped before it queued the run",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const jobId = `wjob_lost_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceWriteJobs).values({
            id: jobId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            kind: "claims_upgrade",
            generation: 1,
            desiredSha: f.sha,
            status: "queued",
            payload: { jobWorkspaceUrl: f.workspaceUrl },
          }),
        )
        await ageWriteJobs(f)

        await runTipCheck(f)
        expect(
          await workspaceRuns(f, "workspace-write-claims-upgrade"),
        ).toEqual([
          expect.objectContaining({
            input: expect.objectContaining({ jobId }),
          }),
        ])
      },
    )
  },
)

it(
  "cron marks a stale queued write job of an earlier generation as failed and does not queue it",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const jobId = `wjob_superseded_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceWriteJobs).values({
            id: jobId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            kind: "ui_file_edit",
            generation: 0,
            desiredSha: f.sha,
            status: "queued",
            payload: { jobWorkspaceUrl: f.workspaceUrl },
          }),
        )
        await ageWriteJobs(f)

        await runTipCheck(f)
        const [job] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({
              status: workspaceWriteJobs.status,
              payload: workspaceWriteJobs.payload,
            })
            .from(workspaceWriteJobs)
            .where(eq(workspaceWriteJobs.id, jobId)),
        )
        expect(job).toEqual({
          status: "failed",
          payload: expect.objectContaining({ failureReason: "superseded" }),
        })
        expect(await workspaceRuns(f, "workspace-write-ui-file-edit")).toEqual(
          [],
        )
      },
    )
  },
)

it(
  "cron queues the index and commit projection jobs of a tip that an earlier failed run stored",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)
        // The failed run stored the tip in `desired_sha`, then stopped.
        expect((await f.resolveRevision(true)).sha).toBe(sha)
        const tipJobs = async () => ({
          // The hydrate also queues an index when it publishes. Count only
          // the jobs of the tip check.
          index: (await workspaceRuns(f, "workspace-index")).filter(
            (run) =>
              (run.input as { revision?: { sha?: string } }).revision?.sha ===
                sha && run.idempotencyKey?.startsWith("workspace-tip-index:"),
          ).length,
          commits: (
            await workspaceRuns(f, "workspace-commit-projection")
          ).filter((run) =>
            run.idempotencyKey?.startsWith("workspace-tip-commits:"),
          ).length,
        })

        // The keys hold the UTC hour that each check gets.
        await runTipCheck(f, "2026-01-01T09")
        expect(await tipJobs()).toEqual({ index: 1, commits: 1 })
        // The hydrate is in flight, and the keys hold the same hour.
        await runTipCheck(f, "2026-01-01T09")
        expect(await tipJobs()).toEqual({ index: 1, commits: 1 })
      },
    )
  },
)

it(
  "cron queues the commit projection job of a tip that a hydrate published after the run that queued it stopped",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const sha = pushSourcesFile(f)
        // The stopped run stored the tip and queued its hydrate. Then it
        // stopped before it queued the index and commit projection jobs.
        const revision = await f.resolveRevision(true)
        expect(revision.sha).toBe(sha)
        const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision,
        })
        expect(await hydrate.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
        })

        await runTipCheck(f, "2026-01-01T09")
        // The hydrate queued the index of the tip when it published it.
        expect(
          (await workspaceRuns(f, "workspace-index")).filter(
            (run) =>
              (run.input as { revision?: { sha?: string } }).revision?.sha ===
              sha,
          ),
        ).toHaveLength(1)
        expect(
          (await workspaceRuns(f, "workspace-commit-projection")).map(
            (run) => run.idempotencyKey,
          ),
        ).toEqual([
          `workspace-tip-commits:${f.workspaceId}:${revision.generation}:${revision.defaultBranch}:${sha}:2026-01-01T09`,
        ])
      },
    )
  },
)

/** The triggers of the upgrade scans that are queued for the org of the fixture. */
async function upgradeScanTriggers(f: NativeHydrationFixture) {
  const result = await getSystemDb().execute(sql`
    select input->>'trigger' as trigger from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'workspace-upgrade-scan'
      and input->>'orgId' = ${f.org.id}
  `)
  return (result.rows as Array<{ trigger: string }>).map((row) => row.trigger)
}

describe("cron write probe and the upgrade scan", () => {
  it.each([
    {
      name: "read-only to writable (an admin fixed the access)",
      stored: "read_only" as const,
      github: { githubWriteView: "writable" as const },
      next: "writable",
    },
    {
      name: "writable to read-only (the App lost Contents: write)",
      stored: "writable" as const,
      github: {
        githubWriteView: "writable" as const,
        githubRepoPermissions: { push: false },
        githubInstallationPermissions: { contents: "read" },
      },
      next: "read_only",
    },
  ])(
    "queues the upgrade scan when the stored write access changes from $name",
    { timeout: 60_000 },
    async ({ stored, github, next }) => {
      await withNativeHydrationFixture(
        { github: true, writeStatus: stored, ...github },
        async (f) => {
          await f.publish()
          // The hydrate also queues a scan for the new format, in its own
          // step: count only the scans of a write access change.
          const writeAccessScans = async () =>
            (await upgradeScanTriggers(f)).filter((trigger) =>
              trigger.startsWith("write-access:"),
            )
          expect(await writeAccessScans()).toEqual([])
          await runTipCheck(f, "2026-10-17T01")
          expect(await writeAccessScans()).toEqual([
            `write-access:2026-10-17T01:${f.workspaceId}:${next}`,
          ])
          // The tip check of the scan sees no change: it queues no second scan.
          await runTipCheck(f, "2026-10-17T01")
          expect(await writeAccessScans()).toHaveLength(1)
        },
      )
    },
  )
})
