import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import { ensureOrgRepositoryForGitUrl } from "../domain/workspaces/ensure-org-repository.js"
import { upsertConnectionDirectory } from "../models/connection-directory.js"
import { getNotionBindingWithRepoByConnectionId } from "../models/notion-connector.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import { enqueueNotionFullSyncAfterConfigPush } from "./enqueue-notion-push-sync.js"

it(
  "accepts one native Notion activation and deduplicates a repeated config push",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_notion`
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "notion",
              config: {
                workspaceId: "provider-workspace",
                status: "installed",
                repositoryId: repository.id,
                branch: "main",
                enabled: true,
                setupPhase: "awaiting_merge",
                pendingConfigPrCreating: false,
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const input = {
            orgId: f.org.id,
            connectionId,
            repositoryId: repository.id,
            branch: "main",
            scopeFromRepo: { resources: [] },
          }
          await enqueueNotionFullSyncAfterConfigPush(input)
          await enqueueNotionFullSyncAfterConfigPush(input)
          expect(
            await getNotionBindingWithRepoByConnectionId(
              f.org.id,
              connectionId,
            ),
          ).toMatchObject({
            setupPhase: "initial_sync",
            repositoryId: repository.id,
            branch: "main",
          })
          const runs = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { connectionId?: string })?.connectionId ===
              connectionId,
          )
          expect(runs).toMatchObject([
            {
              status: "pending",
              workflowName: "notion-sync-content",
              input: { orgId: f.org.id, orgSlug: f.org.slug, connectionId },
            },
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)
