import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import { ensureOrgRepositoryForGitUrl } from "../domain/workspaces/ensure-org-repository.js"
import { upsertConnectionDirectory } from "../models/connection-directory.js"
import { getNotionBindingWithRepoByConnectionId } from "../models/notion-connector.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import {
  connectorConfigKey,
  enqueueConnectorContentSync,
} from "./enqueue-connector-content-sync.js"
import { enqueueNotionFullSyncAfterConfigPush } from "./enqueue-notion-push-sync.js"

it.each([false, true])(
  "accepts a durable Notion activation (canceled before activation: %s)",
  { timeout: 30_000 },
  async (canceled) => {
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
          if (canceled) {
            const owner = await backend.createWorkflowRun({
              workflowName: "notion-sync-content",
              version: null,
              idempotencyKey: `connector-content:${connectionId}:1:${connectorConfigKey(input.scopeFromRepo)}`,
              config: {},
              context: null,
              input: {
                orgId: f.org.id,
                orgSlug: f.org.slug,
                connectionId,
                contentSyncGeneration: 1,
                configKey: connectorConfigKey(input.scopeFromRepo),
                contentSyncBinding: {
                  provider: "notion",
                  repositoryId: repository.id,
                  branch: "main",
                  workspaceId: "provider-workspace",
                  cloudId: null,
                  atlassianApiBaseUrl: null,
                },
              },
              parentStepAttemptNamespaceId: null,
              parentStepAttemptId: null,
              availableAt: null,
              deadlineAt: null,
            })
            await new OpenWorkflow({ backend }).cancelWorkflowRun(owner.id)
            await enqueueNotionFullSyncAfterConfigPush(input)
            expect(
              await getNotionBindingWithRepoByConnectionId(
                f.org.id,
                connectionId,
              ),
            ).toMatchObject({ setupPhase: "sync_failed" })
            expect(
              await enqueueConnectorContentSync({
                orgId: f.org.id,
                orgSlug: f.org.slug,
                connectionId,
                provider: "notion",
                repositoryId: repository.id,
                branch: "main",
              }),
            ).toBe(true)
            expect(
              await getNotionBindingWithRepoByConnectionId(
                f.org.id,
                connectionId,
              ),
            ).toMatchObject({ setupPhase: "initial_sync" })
            const retryOwners = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.filter(
              (run) =>
                (run.input as { connectionId?: string })?.connectionId ===
                connectionId,
            )
            expect(retryOwners).toHaveLength(2)
            expect(
              retryOwners.find((run) => run.status === "pending")?.input,
            ).toMatchObject({ contentSyncGeneration: 2 })
            return
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
          const other = {
            ...input,
            scopeFromRepo: {
              resources: [
                { externalId: "page-b", type: "page" as const, title: "B" },
              ],
            },
          }
          await enqueueNotionFullSyncAfterConfigPush(other)
          await Promise.all([
            enqueueNotionFullSyncAfterConfigPush(input),
            enqueueNotionFullSyncAfterConfigPush(input),
          ])
          const repeated = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { connectionId?: string })?.connectionId ===
              connectionId,
          )
          expect(repeated).toHaveLength(3)
          expect(
            repeated
              .map(
                (run) =>
                  (run.input as { contentSyncGeneration: number })
                    .contentSyncGeneration,
              )
              .sort(),
          ).toEqual([1, 2, 3])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)
