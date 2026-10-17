import { eq } from "drizzle-orm"
import pg from "pg"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { getWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import {
  listOrgWorkspaces,
  persistOrgFirstWorkspace,
} from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { readIngestSkillBundle } from "../ingestion/skill-bundle.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { reingestUpgradeKey } from "./reingest.js"
import { scanWorkspaceReingest } from "./scan.js"

it(
  "scans the re-ingestion of a Workspace below format 3 from the repository maps, with no read of the knowledge store",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "README.md", body: "# Context\n" },
          {
            path: "repositories/api.md",
            body: "---\ngit: https://github.com/existing/api.git\n---\n",
          },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        // A main-era org: the first Workspace gets the org repositories.
        await withOrgIdContext(f.org, async () => {
          const own = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          })
          const api = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: "https://github.com/team-a/api.git",
          })
          if (!own || !api) throw new Error("No org repository was created")
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(repositories)
              .set({ githubConnectionId: f.connectionId })
              .where(eq(repositories.id, api.id)),
          )
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: own.id,
          })
        })
        const [workspace] = (
          await withOrgDbContext(f.org.id, () => listOrgWorkspaces(f.org.id))
        ).filter((row) => row.id === f.workspaceId)
        if (!workspace) throw new Error("The fixture Workspace is missing")
        const bundle = await readIngestSkillBundle()

        // Another session holds the knowledge store. A read of it waits
        // until the lock goes, so a scan that reads it does not finish.
        const lock = new pg.Client({ connectionString: f.databaseUrl })
        await lock.connect()
        let locked = true
        try {
          await lock.query("begin")
          await lock.query(
            "lock table objects, claims, claim_evidence in access exclusive mode",
          )
          const scan = withOrgIdContext(f.org, () =>
            scanWorkspaceReingest({
              orgId: f.org.id,
              workspace,
              bundle,
              format: 0,
              env: parseEnv(process.env),
            }),
          )
          const result = await Promise.race([
            scan,
            new Promise<"waited">((resolve) =>
              setTimeout(() => resolve("waited"), 15_000),
            ),
          ])
          await lock.query("rollback")
          locked = false
          await scan
          expect(result).toMatchObject({ kind: "pending", status: "blocked" })
        } finally {
          if (locked) await lock.query("rollback")
          await lock.end()
        }
        const row = await withOrgIdContext(f.org, () =>
          getWorkspaceUpgradeRow(
            f.workspaceId,
            reingestUpgradeKey(bundle.name),
          ),
        )
        expect(row?.upgrade.blockedReason).toBe("needs_format")
        expect(
          row?.upgrade.estimate?.perRepository.map((entry) => entry.repository),
        ).toEqual(["existing/api", "team-a/api"])
      },
    )
  },
)
