import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
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
