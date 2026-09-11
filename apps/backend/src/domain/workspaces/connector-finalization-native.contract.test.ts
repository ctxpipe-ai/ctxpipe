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
} from "../../models/confluence-sync-target.js"
import {
  getConnectionDirectoryByConnectionId,
  upsertConnectionDirectory,
} from "../../models/connection-directory.js"
import { reconcileConnectorContentSync } from "../../models/connector-content-sync.js"
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
import { enqueueConfluenceFullSyncAfterConfigPush } from "../../openworkflow/enqueue-confluence-push-sync.js"
import { enqueueConnectorContentSync } from "../../openworkflow/enqueue-connector-content-sync.js"
import { enqueueNotionFullSyncAfterConfigPush } from "../../openworkflow/enqueue-notion-push-sync.js"
import { confluenceSyncContent } from "../../openworkflow/workflows/confluence-sync-content.js"
import { linearSyncContent } from "../../openworkflow/workflows/linear-sync-content.js"
import { notionSyncContent } from "../../openworkflow/workflows/notion-sync-content.js"
import { parseConfluenceConfigYamlContent } from "../../services/confluence/config-yaml.js"
import { parseNotionConfigYamlContent } from "../../services/notion/config-yaml.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it.each(["notion", "confluence"] as const)(
  "reordered %s config pushes reuse their native owner while A-B-A changes get new owners",
  { timeout: 30_000 },
  async (provider) => {
    await withNativeHydrationFixture(
      { namespaceId: "default", github: true },
      async (f) => {
        await f.handle.cancel()
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_ordered_push`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(connections).values({
            id: connectionId,
            orgId: f.org.id,
            type: provider === "confluence" ? "forge" : "notion",
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
          }),
        )
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
          const admit = async (reordered: boolean, changed = false) => {
            if (provider === "notion") {
              const resources = [
                { id: "a", type: "page", title: changed ? "Changed" : "A" },
                { title: "B", type: "database", id: "b" },
              ]
              const scopeFromRepo = parseNotionConfigYamlContent(
                JSON.stringify({
                  resources: reordered ? resources.reverse() : resources,
                }),
              )
              if (!scopeFromRepo) throw new Error("Invalid fixture scope")
              await enqueueNotionFullSyncAfterConfigPush({
                orgId: f.org.id,
                connectionId,
                repositoryId: repository.id,
                branch: "main",
                scopeFromRepo,
              })
            } else {
              const spaces = [
                {
                  key: changed ? "OTHER" : "ENG",
                  selectedPageIds: reordered ? ["2", "1"] : ["1", "2"],
                },
                { key: "DOC", selectedPageIds: reordered ? null : [] },
              ]
              const scopeFromRepo = parseConfluenceConfigYamlContent(
                JSON.stringify({
                  spaces: reordered ? spaces.reverse() : spaces,
                }),
              )
              if (!scopeFromRepo) throw new Error("Invalid fixture scope")
              await enqueueConfluenceFullSyncAfterConfigPush({
                orgId: f.org.id,
                connectionId,
                repositoryName: "fixture/hydration-contract",
                githubConnectionId: f.connectionId,
                branch: "main",
                scopeFromRepo,
                log: {
                  error: (error) => {
                    throw error
                  },
                },
              })
            }
          }
          const owners = async () =>
            (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) =>
                run.workflowName === `${provider}-sync-content` &&
                (run.input as { connectionId?: string }).connectionId ===
                  connectionId,
            )
          await admit(false)
          expect(await owners()).toHaveLength(1)
          await admit(true)
          expect(await owners()).toHaveLength(1)
          await admit(false, true)
          expect(await owners()).toHaveLength(2)
          await admit(false)
          expect(await owners()).toHaveLength(3)
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
      { namespaceId: "default", github: true, githubWriteView: "writable" },
      async (f) => {
        await f.handle.cancel()
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
            expect(
              await enqueueConnectorContentSync({
                orgId: f.org.id,
                orgSlug: f.org.slug,
                connectionId,
                provider,
                repositoryId: repository.id,
                branch: "main",
                configKey: `native-reactivation:${f.id}`,
              }),
            ).toBe(true)
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
                : "staleLegacy" in scenario
                  ? {}
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
                  expect(
                    await enqueueConnectorContentSync({
                      orgId: f.org.id,
                      orgSlug: f.org.slug,
                      connectionId,
                      provider,
                      repositoryId: repository.id,
                      branch: "main",
                      configKey: `native-reactivation:${f.id}`,
                    }),
                  ).toBe(true)
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
