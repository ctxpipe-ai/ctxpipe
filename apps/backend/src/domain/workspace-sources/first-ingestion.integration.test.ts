import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"
import { beforeAll, expect, it, vi } from "vitest"

import { withOrgDbContext } from "../../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

it(
  "links the repository of a merged plain git source and starts its first ingestion",
  { timeout: 120_000 },
  async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "vercel")
    try {
      await withNativeHydrationFixture(
        { github: true, githubWriteView: "writable" },
        async (f) => {
          await f.publish()
          // The plain git host resolves to a public address, and each git
          // read of it goes to the local fixture repository.
          const restore = usePlainGitNetwork({
            lookup: async () => [{ address: "140.82.112.3" }],
            gitConfig: [
              [`url.${f.remote}.insteadOf`, "https://git.example.org/team/app"],
            ],
          })
          try {
            mkdirSync(join(f.directory, "sources/git/git.example.org"), {
              recursive: true,
            })
            writeFileSync(
              join(f.directory, "sources/git/git.example.org/team-app.md"),
              "---\nprovider: git\nurl: https://git.example.org/team/app.git\n---\n",
            )
            f.git("add", "sources")
            f.git(
              "-c",
              "user.name=Human",
              "-c",
              "user.email=human@example.test",
              "commit",
              "-m",
              "Add a plain git source",
            )
            f.git("push", f.remote, "HEAD:refs/heads/main")
            const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              revision: await f.resolveRevision(true),
            })
            expect(await hydrate.result({ timeoutMs: 60_000 })).toMatchObject({
              hydrated: true,
            })

            const [source] = await withOrgDbContext(f.org.id, (db) =>
              db
                .select()
                .from(workspaceSources)
                .where(
                  eq(
                    workspaceSources.sourceKey,
                    "sources/git/git.example.org/team-app.md",
                  ),
                ),
            )
            expect(source).toMatchObject({
              provider: "git",
              connectionId: null,
              status: "ok",
            })
            // The link makes the org repository row with no connection, and
            // starts its first org ingestion.
            const rows = await withOrgDbContext(f.org.id, (db) =>
              db
                .select({
                  gitUrl: repositories.gitUrl,
                  githubConnectionId: repositories.githubConnectionId,
                })
                .from(repositories)
                .where(eq(repositories.orgId, f.org.id)),
            )
            expect(rows).toContainEqual({
              gitUrl: "https://git.example.org/team/app",
              githubConnectionId: null,
            })
            const requested = await withOrgDbContext(f.org.id, (db) =>
              db
                .select({ gitUrl: repositoryIngestionRequests.repositoryUrl })
                .from(repositoryIngestionRequests)
                .where(eq(repositoryIngestionRequests.orgId, f.org.id)),
            )
            expect(requested.map((row) => row.gitUrl)).toContain(
              "https://git.example.org/team/app",
            )
          } finally {
            restore()
          }
        },
      )
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
