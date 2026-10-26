import { eq } from "drizzle-orm"
import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceUpgradeRow,
  insertWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  listOrgWorkspaces,
  persistOrgFirstWorkspace,
} from "../../models/workspaces.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { readIngestSkillBundle } from "../ingestion/skill-bundle.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { WRITE_STATUS_REASONS } from "../workspaces/write-status.js"
import { formatUpgradeKey, GIT_UPGRADE_STEPS } from "./registry.js"
import { reingestUpgradeKey } from "./reingest.js"
import { scanWorkspaceReingest, scanWorkspaceUpgrade } from "./scan.js"

// The DNS of the test: each plain git host resolves to a public address.
let restoreNetwork = () => {}
beforeAll(() => {
  restoreNetwork = usePlainGitNetwork({
    lookup: async () => [{ address: "93.184.215.14" }],
  })
})
afterAll(() => restoreNetwork())

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
          // A main-era plain git repository: public HTTPS, no connection
          // (CTX-815). The one with a port is not read as plain git.
          const plain = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: "https://git.example.org/team-d/plain.git",
          })
          const refused = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: "https://git.example.org:8443/team-d/refused.git",
          })
          if (!own || !api || !plain || !refused)
            throw new Error("No org repository was created")
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
            reingestUpgradeKey(bundle.version),
          ),
        )
        expect(row?.upgrade.blockedReason).toBe("needs_format")
        expect(
          row?.upgrade.estimate?.perRepository.map((entry) => entry.repository),
        ).toEqual([
          "existing/api",
          "git.example.org/team-d/plain",
          "team-a/api",
        ])
      },
    )
  },
)

it(
  "blocks the format upgrade of a remote that is not GitHub with the stored reason, not with the GitHub App copy",
  { timeout: 60_000 },
  async () => {
    // No GitHub binding: the remote is a local bare repository.
    await withNativeHydrationFixture(
      {
        writeStatus: "read_only",
        files: [{ path: "README.md", body: "# Context\n" }],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ readOnlyReason: WRITE_STATUS_REASONS.nonGithubHost })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const [workspace] = (
          await withOrgDbContext(f.org.id, () => listOrgWorkspaces(f.org.id))
        ).filter((row) => row.id === f.workspaceId)
        if (!workspace) throw new Error("The fixture Workspace is missing")
        await withOrgIdContext(f.org, () =>
          scanWorkspaceUpgrade({
            orgId: f.org.id,
            workspace,
            steps: GIT_UPGRADE_STEPS,
            format: 0,
            env: parseEnv(process.env),
          }),
        )
        const row = await withOrgIdContext(f.org, () =>
          getWorkspaceUpgradeRow(f.workspaceId, formatUpgradeKey(3)),
        )
        expect(row).toMatchObject({
          status: "blocked",
          upgrade: {
            blockedReason: "write_access",
            note: WRITE_STATUS_REASONS.nonGithubHost,
          },
        })
      },
    )
  },
)

it(
  "keeps a completed re-ingestion of the same version and drops the waiting row of another version",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        format: 3,
        files: [{ path: "README.md", body: "# Context\n" }],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const bundle = await readIngestSkillBundle()
        const doneKey = reingestUpgradeKey(bundle.version)
        const waitingKey = reingestUpgradeKey("ingest-5e55efbeee7bd96b")
        expect(doneKey).not.toBe(waitingKey)
        const [workspace] = (
          await withOrgDbContext(f.org.id, () => listOrgWorkspaces(f.org.id))
        ).filter((row) => row.id === f.workspaceId)
        if (!workspace) throw new Error("The fixture Workspace is missing")
        const result = await withOrgIdContext(f.org, async () => {
          for (const [key, status, generation] of [
            [doneKey, "completed", 1],
            [waitingKey, "awaiting_operator", 2],
          ] as const)
            await insertWorkspaceUpgradeRow({
              workspaceId: f.workspaceId,
              generation,
              status,
              upgrade: {
                key,
                fromFormat: 3,
                targetFormat: 3,
                repositories: [],
              },
            })
          return scanWorkspaceReingest({
            orgId: f.org.id,
            workspace,
            bundle,
            format: 3,
            env: parseEnv(process.env),
          })
        })
        expect(result).toMatchObject({ kind: "pending", status: "completed" })
        await withOrgIdContext(f.org, async () => {
          expect(await getWorkspaceUpgradeRow(f.workspaceId, waitingKey)).toBe(
            null,
          )
          expect(
            (await getWorkspaceUpgradeRow(f.workspaceId, doneKey))?.status,
          ).toBe("completed")
        })
      },
    )
  },
)
