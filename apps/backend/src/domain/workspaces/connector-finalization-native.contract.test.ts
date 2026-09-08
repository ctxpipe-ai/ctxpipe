import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { upsertForgeInstallationFromEvent } from "../../models/atlassian-connector.js"
import {
  finalizeConfluenceSyncTargetAfterContentWorkflow,
  getConfluenceSyncTargetWithRepoByConnectionId,
  markConfluenceSyncTargetInitialSync,
} from "../../models/confluence-sync-target.js"
import {
  getConnectionDirectoryByConnectionId,
  upsertConnectionDirectory,
} from "../../models/connection-directory.js"
import { reconcileConnectorContentSync } from "../../models/connector-content-sync.js"
import {
  claimLinearBindingInitialSync,
  finalizeLinearBindingAfterContentWorkflow,
  getLinearBindingWithRepoByConnectionId,
} from "../../models/linear-connector.js"
import {
  claimNotionBindingInitialSync,
  finalizeNotionBindingAfterContentWorkflow,
  getNotionBindingWithRepoByConnectionId,
  getNotionConnectionByConnectionId,
  updateNotionConnectionTokens,
} from "../../models/notion-connector.js"
import { confluenceSyncContent } from "../../openworkflow/workflows/confluence-sync-content.js"
import { linearSyncContent } from "../../openworkflow/workflows/linear-sync-content.js"
import { notionSyncContent } from "../../openworkflow/workflows/notion-sync-content.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each([
  {
    provider: "linear",
    status: "failed",
    phase: "draft",
    terminalOwner: true,
    staleLegacy: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "draft",
    terminalOwner: true,
    staleLegacy: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "draft",
    terminalOwner: true,
    staleLegacy: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    legacyOwner: true,
    legacyProviderChanged: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    ownerFirst: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    ownerFirst: true,
    terminalProviderChanged: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    ownerFirst: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    ownerFirst: true,
    terminalProviderChanged: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    ownerFirst: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    ownerFirst: true,
    terminalProviderChanged: true,
  },
  { provider: "linear", status: "completed", phase: "live" },
  { provider: "linear", status: "partial_failed", phase: "sync_failed" },
  { provider: "linear", status: "failed", phase: "sync_failed" },
  { provider: "notion", status: "completed", phase: "live" },
  { provider: "notion", status: "partial_failed", phase: "sync_failed" },
  { provider: "notion", status: "failed", phase: "sync_failed" },
  { provider: "confluence", status: "completed", phase: "live" },
  { provider: "confluence", status: "partial_failed", phase: "sync_failed" },
  { provider: "confluence", status: "failed", phase: "sync_failed" },
  { provider: "linear", status: "completed", phase: "initial_sync" },
  { provider: "notion", status: "completed", phase: "initial_sync" },
  { provider: "confluence", status: "completed", phase: "initial_sync" },
  {
    provider: "linear",
    status: "completed",
    phase: "initial_sync",
    providerChanged: true,
  },
  {
    provider: "notion",
    status: "completed",
    phase: "initial_sync",
    providerChanged: true,
  },
  {
    provider: "confluence",
    status: "completed",
    phase: "initial_sync",
    providerChanged: true,
  },
  {
    provider: "linear",
    status: "completed",
    phase: "initial_sync",
    activationChanged: true,
  },
  {
    provider: "notion",
    status: "completed",
    phase: "initial_sync",
    activationChanged: true,
  },
  {
    provider: "confluence",
    status: "completed",
    phase: "initial_sync",
    activationChanged: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    reactivated: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    reactivated: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "initial_sync",
    terminalOwner: true,
    reactivated: true,
  },
  {
    provider: "linear",
    status: "completed",
    phase: "initial_sync",
    pendingOwner: true,
  },
  {
    provider: "notion",
    status: "completed",
    phase: "initial_sync",
    pendingOwner: true,
  },
  {
    provider: "confluence",
    status: "completed",
    phase: "initial_sync",
    pendingOwner: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "sync_failed",
    missingOwner: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "sync_failed",
    missingOwner: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "sync_failed",
    missingOwner: true,
  },
  {
    provider: "linear",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    legacyOwner: true,
  },
  {
    provider: "notion",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    legacyOwner: true,
  },
  {
    provider: "confluence",
    status: "failed",
    phase: "sync_failed",
    terminalOwner: true,
    legacyOwner: true,
  },
] as const)(
  "projects $provider $status onto the same initial binding as $phase; providerChanged=$providerChanged; activationChanged=$activationChanged; terminalOwner=$terminalOwner; reactivated=$reactivated; pendingOwner=$pendingOwner; missingOwner=$missingOwner; legacyOwner=$legacyOwner; legacyProviderChanged=$legacyProviderChanged; staleLegacy=$staleLegacy",
  { timeout: 30_000 },
  async (scenario) => {
    const { provider, status, phase } = scenario
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
                setupPhase:
                  "staleLegacy" in scenario
                    ? "draft"
                    : "ownerFirst" in scenario
                      ? "awaiting_merge"
                      : "initial_sync",
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
              setupPhase:
                "staleLegacy" in scenario
                  ? "draft"
                  : "ownerFirst" in scenario
                    ? "awaiting_merge"
                    : "initial_sync",
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
          if ("activationChanged" in scenario) {
            const activate = {
              linear: claimLinearBindingInitialSync,
              notion: claimNotionBindingInitialSync,
              confluence: markConfluenceSyncTargetInitialSync,
            }[provider]
            await activate({
              connectionId,
              repositoryId: repository.id,
              branch: "main",
            })
          } else if ("providerChanged" in scenario)
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(connections)
                .set({
                  config: sql`${connections.config} || ${JSON.stringify({ workspaceId: "new-provider", cloudId: "new-cloud" })}::jsonb`,
                })
                .where(eq(connections.id, connectionId)),
            )
          else if (
            phase === "initial_sync" &&
            !("terminalOwner" in scenario) &&
            !("pendingOwner" in scenario)
          )
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaces)
                .set({ desiredGeneration: f.revision.generation + 1 })
                .where(eq(workspaces.id, f.workspaceId)),
            )
          if ("providerChanged" in scenario) {
            await upsertConnectionDirectory(connection)
            const directory =
              await getConnectionDirectoryByConnectionId(connectionId)
            expect(directory).toMatchObject(
              provider === "confluence"
                ? { forgeCloudId: "new-cloud" }
                : provider === "notion"
                  ? { notionWorkspaceId: "new-provider" }
                  : { linearWorkspaceId: "new-provider" },
            )
          }
          if ("missingOwner" in scenario) {
            expect(
              await reconcileConnectorContentSync({
                orgId: f.org.id,
                connectionId,
                admissionFailedGeneration: 0,
              }),
            ).toBe(false)
          } else if (
            "terminalOwner" in scenario ||
            "pendingOwner" in scenario
          ) {
            f.runner.implementWorkflow(
              linearSyncContent.spec,
              linearSyncContent.fn,
            )
            f.runner.implementWorkflow(
              notionSyncContent.spec,
              notionSyncContent.fn,
            )
            f.runner.implementWorkflow(
              confluenceSyncContent.spec,
              confluenceSyncContent.fn,
            )
            const command = {
              orgId: f.org.id,
              orgSlug: f.org.slug,
              connectionId,
              contentSyncGeneration: "ownerFirst" in scenario ? 1 : 0,
              ...("ownerFirst" in scenario
                ? {
                    contentSyncBinding: {
                      provider,
                      repositoryId: repository.id,
                      branch: "main",
                      workspaceId:
                        provider === "confluence" ? null : "provider-workspace",
                      cloudId:
                        provider === "confluence" ? "fixture-cloud" : null,
                      atlassianApiBaseUrl: null,
                    },
                  }
                : {}),
            }
            const options =
              "pendingOwner" in scenario
                ? { availableAt: new Date(Date.now() + 60_000) }
                : { deadlineAt: new Date(Date.now() + 1500) }
            if ("legacyOwner" in scenario) {
              const legacy = await f.backend.createWorkflowRun({
                workflowName: `${provider}-sync-content`,
                version: null,
                idempotencyKey: null,
                config: {},
                context: null,
                input: { orgId: f.org.id, orgSlug: f.org.slug, connectionId },
                parentStepAttemptNamespaceId: null,
                parentStepAttemptId: null,
                availableAt: null,
                deadlineAt: new Date(Date.now() + 1500),
              })
              const worker = f.runner.newWorker({ concurrency: 1 })
              try {
                await worker.start()
                await expect
                  .poll(
                    async () =>
                      (
                        await f.backend.getWorkflowRun({
                          workflowRunId: legacy.id,
                        })
                      )?.status,
                    { timeout: 10_000 },
                  )
                  .toBe("failed")
                expect(
                  (
                    await f.backend.listStepAttempts({
                      workflowRunId: legacy.id,
                    })
                  ).data.length,
                ).toBeGreaterThan(0)
              } finally {
                await worker.stop()
              }
              if ("legacyProviderChanged" in scenario)
                await upsertForgeInstallationFromEvent({
                  orgId: f.org.id,
                  connectionId,
                  cloudId: "new-cloud",
                  status: "installed",
                })
            } else {
              const handle =
                provider === "linear"
                  ? await f.runner.runWorkflow(
                      linearSyncContent.spec,
                      command,
                      options,
                    )
                  : provider === "notion"
                    ? await f.runner.runWorkflow(
                        notionSyncContent.spec,
                        command,
                        options,
                      )
                    : await f.runner.runWorkflow(
                        confluenceSyncContent.spec,
                        command,
                        options,
                      )
              if ("pendingOwner" in scenario) {
                expect(
                  await reconcileConnectorContentSync({
                    orgId: f.org.id,
                    connectionId,
                    admissionFailedGeneration: 0,
                  }),
                ).toBe(true)
                const pending = await f.backend.getWorkflowRun({
                  workflowRunId: handle.workflowRun.id,
                })
                expect(pending?.status).toBe("pending")
              } else {
                const worker = f.runner.newWorker({ concurrency: 1 })
                try {
                  await worker.start()
                  if ("staleLegacy" in scenario)
                    expect(
                      await handle.result({ timeoutMs: 10_000 }),
                    ).toMatchObject({ status: "superseded" })
                  else
                    await expect(
                      handle.result({ timeoutMs: 10_000 }),
                    ).rejects.toThrow()
                } finally {
                  await worker.stop()
                }
                if ("terminalProviderChanged" in scenario) {
                  await withOrgDbContext(f.org.id, (db) =>
                    db
                      .update(connections)
                      .set({
                        config: sql`${connections.config} || ${JSON.stringify({ workspaceId: "new-provider", cloudId: "new-cloud" })}::jsonb`,
                      })
                      .where(eq(connections.id, connectionId)),
                  )
                }
                if ("reactivated" in scenario) {
                  const activate = {
                    linear: claimLinearBindingInitialSync,
                    notion: claimNotionBindingInitialSync,
                    confluence: markConfluenceSyncTargetInitialSync,
                  }[provider]
                  await activate({
                    connectionId,
                    repositoryId: repository.id,
                    branch: "main",
                  })
                }
              }
            }
          } else {
            await finalize({
              connectionId,
              binding: {
                contentSyncGeneration: 0,
                repositoryId: repository.id,
                revision: f.revision,
                provider:
                  provider === "confluence"
                    ? {
                        kind: "confluence",
                        cloudId: "fixture-cloud",
                        atlassianApiBaseUrl: null,
                      }
                    : { kind: provider, workspaceId: "provider-workspace" },
              },
              workflowStatus: status,
            })
          }
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
