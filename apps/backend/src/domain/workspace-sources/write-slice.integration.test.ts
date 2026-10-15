import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
import { cleanupRemovedSources } from "./sync.js"
import { writeWorkspaceSlice } from "./write-slice.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

it(
  "queues the connector mirror commit from a workflow step, where no request logger exists",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.publish()
        mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
        writeFileSync(
          join(f.directory, ".ctxpipe/sources.yaml"),
          [
            "version: 1",
            "sources:",
            "  - id: issues",
            "    provider: linear",
            "    connection: con_linear",
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
        const sourcesRevision = f.git("rev-parse", "HEAD")

        // The sources sync calls the writer like this: no withLogger, no Hono.
        const result = await writeWorkspaceSlice(
          {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            provider: "linear",
            connectionId: "con_linear",
            files: [{ path: "linear/teams/ENG/README.md", content: "# ENG\n" }],
            ownedPrefixes: ["linear/teams/ENG/"],
            keepPrefixes: [],
            sourcesRevision,
          },
          parseEnv(process.env),
        )

        expect(result).toEqual({ queued: true })
        const jobs = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({ kind: workspaceWriteJobs.kind })
            .from(workspaceWriteJobs)
            .where(
              and(
                eq(workspaceWriteJobs.workspaceId, f.workspaceId),
                eq(workspaceWriteJobs.kind, "connector_mirror"),
              ),
            ),
        )
        expect(jobs).toHaveLength(1)
      },
    )
  },
)

it(
  "removes the files of a removed source when the sources file changes again before the cleanup",
  { timeout: 90_000 },
  async () => {
    const entry = (id: string, team: string) =>
      `  - {id: ${id}, provider: linear, connection: con_linear, teams: [${team}]}`
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "linear/teams/ENG/README.md", body: "# ENG\n" },
          { path: "knowledge/owner.md", body: "# Owner\n" },
        ],
      },
      async (f) => {
        await f.publish()
        mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
        const commitSources = (lines: string[], message: string) => {
          writeFileSync(
            join(f.directory, ".ctxpipe/sources.yaml"),
            ["version: 1", "sources:", ...lines, ""].join("\n"),
          )
          f.git("add", ".ctxpipe/sources.yaml")
          f.git(
            "-c",
            "user.name=Human",
            "-c",
            "user.email=human@example.test",
            "commit",
            "-m",
            message,
          )
          f.git("push", f.remote, "HEAD:refs/heads/main")
          return f.git("rev-parse", "HEAD")
        }
        commitSources([entry("x", "ENG")], "Add X")
        // R1 removes X and queues its cleanup; R2 edits the file again
        // before the cleanup runs.
        const removedAt = commitSources([entry("y", "OPS")], "Remove X")
        commitSources([entry("y", "OPS"), entry("z", "WEB")], "Add Z")

        const env = parseEnv(process.env)
        const writes = await cleanupRemovedSources({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: removedAt,
          removed: [
            {
              provider: "linear",
              connectionId: "con_linear",
              scope: { teams: ["ENG"] },
            },
          ],
          adapters: SOURCE_ADAPTERS,
          write: async (write) => {
            expect(await writeWorkspaceSlice(write, env)).toEqual({
              queued: true,
            })
          },
        })
        expect(writes).toHaveLength(1)
        // The file changes again between the queue and the commit.
        commitSources(
          [entry("y", "OPS"), entry("z", "WEB"), entry("w", "DOC")],
          "Add W",
        )

        const [job] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({ id: workspaceWriteJobs.id })
            .from(workspaceWriteJobs)
            .where(
              and(
                eq(workspaceWriteJobs.workspaceId, f.workspaceId),
                eq(workspaceWriteJobs.kind, "connector_mirror"),
              ),
            ),
        )
        if (!job) throw new Error("Expected a queued cleanup")
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const { workspaceConnectorMirror } = await import(
          "../../openworkflow/workflows/workspace-connector-mirror.js"
        )
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        // The head moved after the queue, so the commit merges onto it.
        runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(job.id),
                ),
              { timeout: 30_000 },
            )
            .toMatchObject({ status: "completed" })
        } finally {
          await worker.stop()
          await backend.stop()
        }
        expect(
          f
            .git("--git-dir", f.remote, "ls-tree", "-r", "--name-only", "main")
            .split("\n"),
        ).toEqual([".ctxpipe/sources.yaml", "knowledge/owner.md"])
      },
    )
  },
)
