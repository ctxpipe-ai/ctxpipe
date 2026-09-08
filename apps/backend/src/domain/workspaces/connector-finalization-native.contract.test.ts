import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import {
  finalizeConfluenceSyncTargetAfterContentWorkflow,
  getConfluenceSyncTargetWithRepoByConnectionId,
} from "../../models/confluence-sync-target.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import {
  finalizeLinearBindingAfterContentWorkflow,
  getLinearBindingWithRepoByConnectionId,
} from "../../models/linear-connector.js"
import {
  finalizeNotionBindingAfterContentWorkflow,
  getNotionBindingWithRepoByConnectionId,
  getNotionConnectionByConnectionId,
  updateNotionConnectionTokens,
} from "../../models/notion-connector.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each([
  { provider: "linear", status: "completed", phase: "live" },
  { provider: "linear", status: "partial_failed", phase: "sync_failed" },
  { provider: "linear", status: "failed", phase: "sync_failed" },
  { provider: "notion", status: "completed", phase: "live" },
  { provider: "notion", status: "partial_failed", phase: "sync_failed" },
  { provider: "notion", status: "failed", phase: "sync_failed" },
  { provider: "confluence", status: "completed", phase: "live" },
  { provider: "confluence", status: "partial_failed", phase: "sync_failed" },
  { provider: "confluence", status: "failed", phase: "sync_failed" },
] as const)(
  "projects $provider $status onto the same initial binding as $phase",
  { timeout: 30_000 },
  async ({ provider, status, phase }) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
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
        const connectionId = `con_${f.id}_${provider}`
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: provider === "confluence" ? "forge" : provider,
              config: {
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                ownerUserId: "fixture-owner",
                cloudId: "fixture-cloud",
                status: "installed",
                repositoryId: repository.id,
                branch: "main",
                enabled: true,
                setupPhase: "initial_sync",
                pendingConfigPrCreating: false,
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        if (provider === "confluence")
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(confluenceSyncTargets).values({
              id: `cst_${f.id}`,
              orgId: f.org.id,
              connectionId,
              repositoryId: repository.id,
              branch: "main",
              enabled: true,
              setupPhase: "initial_sync",
            }),
          )
        try {
          if (provider === "notion" && status === "completed") {
            await updateNotionConnectionTokens({
              orgId: f.org.id,
              connectionId,
              env: parseEnv(process.env),
              accessToken: "native-refreshed-access",
              refreshToken: "native-refreshed-refresh",
            })
            expect(
              await withOrgDbContext(f.org.id, () =>
                getNotionConnectionByConnectionId(
                  f.org.id,
                  connectionId,
                  parseEnv(process.env),
                ),
              ),
            ).toMatchObject({
              accessToken: "native-refreshed-access",
              refreshToken: "native-refreshed-refresh",
            })
          }
          const finalize = {
            linear: finalizeLinearBindingAfterContentWorkflow,
            notion: finalizeNotionBindingAfterContentWorkflow,
            confluence: finalizeConfluenceSyncTargetAfterContentWorkflow,
          }[provider]
          await finalize({
            connectionId,
            repositoryId: repository.id,
            branch: "main",
            workflowStatus: status,
          })
          const read = {
            linear: getLinearBindingWithRepoByConnectionId,
            notion: getNotionBindingWithRepoByConnectionId,
            confluence: getConfluenceSyncTargetWithRepoByConnectionId,
          }[provider]
          expect(await read(f.org.id, connectionId)).toMatchObject({
            setupPhase: phase,
            repositoryId: repository.id,
            branch: "main",
            enabled: true,
          })
        } finally {
          if (provider === "confluence")
            await withOrgDbContext(f.org.id, (db) =>
              db
                .delete(confluenceSyncTargets)
                .where(eq(confluenceSyncTargets.connectionId, connectionId)),
            )
        }
      },
    )
  },
)
