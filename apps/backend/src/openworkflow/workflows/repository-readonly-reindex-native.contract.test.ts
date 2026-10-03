import "../../../test/db.js"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { captureRepositoryExtractionTarget } from "../../domain/workspaces/capture-repository-extraction.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it(
  "does not bind a write destination for a public GitHub workspace without a connection",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "missing",
        writeStatus: "read_only",
        files: [
          {
            path: "AGENTS.md",
            body: "# Public source\nUse amberquartz instructions.\n",
          },
        ],
      },
      async (f) => {
        await f.handle.cancel()
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ githubConnectionId: null })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        expect(repository.created).toBe(true)
        const destination = await withOrgIdContext(f.org, () =>
          captureRepositoryExtractionTarget({
            orgId: f.org.id,
            repositoryUrl: f.workspaceUrl,
            env: parseEnv(process.env),
          }),
        )
        expect(destination).toBeNull()
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)

it(
  "still binds a write destination when the workspace has a GitHub connection",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "missing",
        writeStatus: "read_only",
      },
      async (f) => {
        await f.handle.cancel()
        const destination = await withOrgIdContext(f.org, () =>
          captureRepositoryExtractionTarget({
            orgId: f.org.id,
            repositoryUrl: f.workspaceUrl,
            env: parseEnv(process.env),
          }),
        )
        expect(destination?.workspaceId).toBe(f.workspaceId)
        expect(destination?.revision.access).toBe("write-default")
        expect(destination?.revision.remote.connectionId).toBe(f.connectionId)
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)
