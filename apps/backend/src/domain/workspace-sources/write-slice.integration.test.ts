import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
import { stampSources } from "./stamp-sources.js"
import { cleanupRemovedSources, syncConnectionSources } from "./sync.js"
import { readWorkspaceBlobs, writeWorkspaceSlice } from "./write-slice.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

/** Run the queued connector mirror command of the Workspace to its end. */
async function runConnectorMirror(f: Fixture, jobId: string) {
  const { BackendPostgres } = await import("openworkflow/postgres")
  const { OpenWorkflow } = await import("openworkflow")
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  const runner = new OpenWorkflow({ backend })
  const { workspaceConnectorMirror } =
    await import("../../openworkflow/workflows/workspace-connector-mirror.js")
  const { workspaceSemanticMerge } =
    await import("../../openworkflow/workflows/workspace-semantic-merge.js")
  runner.implementWorkflow(
    workspaceConnectorMirror.spec,
    workspaceConnectorMirror.fn,
  )
  // When the head moved after the queue, the commit merges onto it.
  runner.implementWorkflow(
    workspaceSemanticMerge.spec,
    workspaceSemanticMerge.fn,
  )
  const worker = runner.newWorker({ concurrency: 1 })
  try {
    await worker.start()
    await expect
      .poll(
        () => withOrgIdContext(f.org, () => reconcileWorkspaceWriteJob(jobId)),
        { timeout: 30_000 },
      )
      .toMatchObject({ status: "completed" })
  } finally {
    await worker.stop()
    await backend.stop()
  }
}

async function connectorMirrorJobs(f: Fixture) {
  return withOrgDbContext(f.org.id, (db) =>
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
}

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

        const [job] = await connectorMirrorJobs(f)
        if (!job) throw new Error("Expected a queued cleanup")
        await runConnectorMirror(f, job.id)
        expect(
          f
            .git("--git-dir", f.remote, "ls-tree", "-r", "--name-only", "main")
            .split("\n"),
        ).toEqual([".ctxpipe/sources.yaml", "knowledge/owner.md"])
      },
    )
  },
)

it(
  "drops the write when a file under sources/ changed after the rows' revision",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.publish()
        const commit = (path: string, text: string, message: string) => {
          mkdirSync(join(f.directory, path, ".."), { recursive: true })
          writeFileSync(join(f.directory, path), text)
          f.git("add", path)
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
        const sourcesRevision = commit(
          "sources/linear/eng.md",
          "---\nprovider: linear\nconnection: con_linear\nteams: [ENG]\n---\n",
          "Add the Linear source",
        )
        // A person narrows the source after the projection planned the write.
        commit(
          "sources/linear/eng.md",
          "---\nprovider: linear\nconnection: con_linear\nteams: [OPS]\n---\n",
          "Change the Linear source",
        )
        const write = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          provider: "linear" as const,
          connectionId: "con_linear",
          files: [{ path: "linear/teams/ENG/README.md", content: "# ENG\n" }],
          ownedPrefixes: ["linear/teams/ENG/"],
          keepPrefixes: [],
        }
        const env = parseEnv(process.env)

        expect(
          await writeWorkspaceSlice({ ...write, sourcesRevision }, env),
        ).toEqual({ queued: false })
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
        expect(jobs).toHaveLength(0)

        // A change outside sources/ does not stop the write.
        const head = commit("notes.md", "Notes\n", "Add notes")
        commit("other.md", "Other\n", "Add other")
        expect(
          await writeWorkspaceSlice({ ...write, sourcesRevision: head }, env),
        ).toEqual({ queued: true })
      },
    )
  },
)

it(
  "refuses a slice file or deleted path outside the owned paths",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "linear/teams/OPS/README.md", body: "# OPS\n" }],
      },
      async (f) => {
        await f.publish()
        const write = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          provider: "linear" as const,
          connectionId: "con_linear",
          ownedPrefixes: ["linear/teams/ENG/"],
          keepPrefixes: [],
          sourcesRevision: f.git("rev-parse", "HEAD"),
        }
        const env = parseEnv(process.env)

        await expect(
          writeWorkspaceSlice(
            {
              ...write,
              files: [{ path: "linear/teams/OPS/README.md", content: "# X\n" }],
            },
            env,
          ),
        ).rejects.toThrow("The linear sync refused an unsafe path.")
        await expect(
          writeWorkspaceSlice(
            {
              ...write,
              files: [],
              deletePaths: ["linear/teams/OPS/README.md"],
            },
            env,
          ),
        ).rejects.toThrow("The linear sync refused an unsafe path.")
        // A delete that starts with an owned path but leaves it.
        for (const path of [
          "linear/teams/ENG/../OPS/README.md",
          "linear/teams/ENG/./../OPS/README.md",
          "linear/teams/ENG//README.md",
          "linear/teams/ENG/..\\OPS\\README.md",
          "linear/teams/ENG/.git/config",
          "linear/teams/ENG/README.md/",
        ])
          await expect(
            writeWorkspaceSlice(
              { ...write, files: [], deletePaths: [path] },
              env,
            ),
          ).rejects.toThrow("The linear sync refused an unsafe path.")
        expect(await connectorMirrorJobs(f)).toEqual([])
      },
    )
  },
)

it(
  "writes a slice file as a regular file over a symlink",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "knowledge/owner.md", body: "# Owner\n" },
          {
            path: "linear/teams/ENG/README.md",
            body: "../../../knowledge/owner.md",
            mode: "120000",
          },
        ],
      },
      async (f) => {
        await f.publish()
        const result = await writeWorkspaceSlice(
          {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            provider: "linear",
            connectionId: "con_linear",
            files: [{ path: "linear/teams/ENG/README.md", content: "# ENG\n" }],
            ownedPrefixes: ["linear/teams/ENG/"],
            keepPrefixes: [],
            sourcesRevision: f.git("rev-parse", "HEAD"),
          },
          parseEnv(process.env),
        )
        expect(result).toEqual({ queued: true })
        const [job] = await connectorMirrorJobs(f)
        if (!job) throw new Error("Expected a queued connector mirror")

        await runConnectorMirror(f, job.id)

        expect(
          f.git(
            "--git-dir",
            f.remote,
            "ls-tree",
            "main",
            "linear/teams/ENG/README.md",
          ),
        ).toMatch(/^100644 blob /)
      },
    )
  },
)

it(
  "deletes a dot file and a name that NFC changes inside a managed folder",
  { timeout: 90_000 },
  async () => {
    // Names that a sync does not write, but that can exist in the tree.
    const odd = ["linear/teams/ENG/.notes.md", "linear/teams/ENG/cafe\u0301.md"]
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "linear/teams/ENG/README.md", body: "# ENG\n" },
          ...odd.map((path) => ({ path, body: "# Odd\n" })),
        ],
      },
      async (f) => {
        await f.publish()
        // A full-replace sync of ENG: the fetch no longer has these files.
        const synced = await writeWorkspaceSlice(
          {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            provider: "linear",
            connectionId: "con_linear",
            files: [
              { path: "linear/teams/ENG/README.md", content: "# ENG 2\n" },
            ],
            ownedPrefixes: ["linear/teams/ENG/"],
            keepPrefixes: [],
            deletePaths: odd,
            sourcesRevision: f.git("rev-parse", "HEAD"),
          },
          parseEnv(process.env),
        )
        expect(synced).toEqual({ queued: true })
        const [job] = await connectorMirrorJobs(f)
        if (!job) throw new Error("Expected a queued connector mirror")
        await runConnectorMirror(f, job.id)
        expect(
          f
            .git("--git-dir", f.remote, "ls-tree", "-r", "--name-only", "main")
            .split("\n")
            .filter((path) => path.startsWith("linear/teams/ENG/")),
        ).toEqual(["linear/teams/ENG/README.md"])
      },
    )
  },
)

it(
  "skips the restamp of a file that the write seam refuses and restamps the others",
  { timeout: 90_000 },
  async () => {
    const page = (title: string) => `---\nsource: linear\n---\n# ${title}\n`
    // Stamped with a source path from before a rename.
    const old = (title: string) =>
      stampSources(page(title), ["sources/linear/before.md"])
    const dotted = "linear/teams/ENG/.notes.md"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "linear/teams/ENG/ok.md", body: old("ok") },
          { path: dotted, body: old("notes") },
        ],
      },
      async (f) => {
        await f.publish()
        const revision = f.git("rev-parse", "HEAD")
        await replaceWorkspaceSourceRows({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision,
          rows: [
            {
              sourceKey: "sources/linear/eng.md",
              provider: "linear",
              connectionId: "con_linear",
              scope: { teams: ["ENG"] },
              status: "ok",
              statusDetail: null,
            },
          ],
        })
        const env = parseEnv(process.env)
        const synced = await syncConnectionSources({
          orgId: f.org.id,
          connectionId: "con_linear",
          env,
          adapter: {
            provider: "linear",
            managedPaths: () => ["linear/teams/ENG/"],
            // An incremental patch: the adapter writes nothing again.
            fetch: async () => ({ files: [], deletePaths: [] }),
          },
          write: async (write) => {
            expect(await writeWorkspaceSlice(write, env)).toEqual({
              queued: true,
            })
          },
          readExisting: (workspaceId, owners) =>
            readWorkspaceBlobs({ orgId: f.org.id, workspaceId, env, owners }),
        })
        expect(synced.workspaces).toEqual([f.workspaceId])
        const [job] = await connectorMirrorJobs(f)
        if (!job) throw new Error("Expected a queued connector mirror")
        await runConnectorMirror(f, job.id)
        const show = (path: string) =>
          f.git("--git-dir", f.remote, "show", `main:${path}`)
        expect(show("linear/teams/ENG/ok.md")).toBe(
          stampSources(page("ok"), ["sources/linear/eng.md"]).trim(),
        )
        expect(show(dotted)).toBe(old("notes").trim())
      },
    )
  },
)
