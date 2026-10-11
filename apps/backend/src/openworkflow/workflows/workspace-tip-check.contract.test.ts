import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import { describe, expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { WRITE_STATUS_REASONS } from "../../domain/workspaces/write-status.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"

it(
  "cron queues a missing migration export through real OpenWorkflow outside SQL",
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
          expect(queued).toEqual([
            expect.objectContaining({
              workflowName: "workspace-write-migration-export",
              input: expect.objectContaining({
                workspaceId: f.workspaceId,
                revision: expect.objectContaining({
                  sha: f.sha,
                  access: "write-default",
                }),
              }),
            }),
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "cron resumes a paused write job through the native workflow queue",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const jobId = `wjob_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceWriteJobs).values({
            id: jobId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            kind: "migration_export",
            generation: 1,
            desiredSha: f.sha,
            status: "paused",
            payload: { jobWorkspaceUrl: f.workspaceUrl },
          }),
        )
        const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await handle.result({ timeoutMs: 30_000 })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toEqual([
            expect.objectContaining({
              workflowName: "workspace-write-migration-export",
              input: expect.objectContaining({
                jobId,
                revision: expect.objectContaining({
                  sha: f.sha,
                  access: "write-default",
                }),
              }),
            }),
          ])
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
      { github: true, githubWriteView: "missing", writeStatus: "writable" },
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
              "ctx| has no access to this repository. Connect GitHub to this Workspace, then retry.",
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
    },
  ])(
    "records that it could not check write access after $name",
    { timeout: 60_000 },
    async ({ response }) => {
      await withNativeHydrationFixture(
        { github: true, githubWriteView: "writable" },
        async (f) => {
          await f.publish()
          f.server.use(
            http.get("https://api.github.com/repos/fixture/:repo", response),
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
        },
      )
    },
  )
})
