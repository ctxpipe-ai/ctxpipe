import { eq, sql } from "drizzle-orm"
import { defineWorkflow, OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { Pool } from "pg"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { backfillConnectorContentAdmissions } from "../../db/backfill-connector-content-admissions.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import {
  encodeLinearTokensForDb,
  encodeNotionTokensForDb,
} from "../../lib/connection-config.js"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import {
  activateConnectorSync,
  captureConnectorConfigSyncBinding,
} from "../../models/connector-content-sync.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { confluenceSyncConfig } from "./confluence-sync-config.js"
import {
  type LinearConfigSyncInput,
  linearSyncConfig,
} from "./linear-sync-config.js"
import { notionSyncConfig } from "./notion-sync-config.js"

it.each(
  (["linear", "notion", "confluence"] as const).flatMap((provider) => [
    { provider, failure: false, stale: false, close: false, ownerFirst: false },
    { provider, failure: false, stale: false, close: false, ownerFirst: true },
    {
      provider,
      failure: false,
      stale: false,
      close: false,
      ownerFirst: true,
      captureRestart: true,
    },
    {
      provider,
      failure: false,
      stale: false,
      close: false,
      ownerFirst: false,
      replay: true,
    },
    {
      provider,
      failure: false,
      stale: false,
      close: false,
      ownerFirst: false,
      upgrade: true,
    },
    {
      provider,
      failure: false,
      stale: false,
      close: false,
      ownerFirst: true,
      cancel: true,
    },
    { provider, failure: true, stale: false, close: false, ownerFirst: false },
    { provider, failure: false, stale: true, close: false, ownerFirst: false },
    ...[
      {
        provider,
        failure: false,
        stale: false,
        close: true,
        ownerFirst: false,
      },
      {
        provider,
        failure: false,
        stale: false,
        close: true,
        ownerFirst: false,
        generationSwap: true,
      },
    ],
  ]),
)(
  "native $provider config admission (failure=$failure; stale=$stale; close=$close; ownerFirst=$ownerFirst; upgrade=$upgrade; generationSwap=$generationSwap; replay=$replay; cancel=$cancel; captureRestart=$captureRestart)",
  { timeout: 30_000 },
  async (scenario) => {
    const { provider, failure, stale, close, ownerFirst } = scenario
    const upgrade = "upgrade" in scenario && scenario.upgrade
    const replay = "replay" in scenario && scenario.replay
    const captureRestart =
      "captureRestart" in scenario && scenario.captureRestart

    const config =
      provider === "linear"
        ? "version: 1\nsource: linear\nworkspace:\n  id: provider-workspace\n  name: Fixture\nscope: {}\n"
        : provider === "notion"
          ? "version: 1\nsource: notion\nresources: []\n"
          : "version: 1\nsource: confluence\nspaces: []\n"
    const responses: Record<string, { body: unknown }> = {
      "GET ref/heads/main": { body: { object: { sha: "a".repeat(40) } } },
      [`GET commits/${"a".repeat(40)}`]: {
        body: { tree: { sha: "b".repeat(40) } },
      },
      "POST refs": { body: {} },
      "POST blobs": { body: { sha: "c".repeat(40) } },
      "POST trees": { body: { sha: "d".repeat(40) } },
      "POST commits": { body: { sha: "e".repeat(40) } },
    }
    let rebind: (() => Promise<void>) | undefined
    let pullsCreated = 0
    const pullUpdates: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubContentFiles: close
          ? {}
          : { [`${provider}/config.yaml`]: config },
        ...(close
          ? {
              githubGitResponses: responses,
              onGithubGitRequest: (
                method: string,
                path: string,
                body: unknown,
              ) => {
                if (method === "POST" && path === "refs") {
                  const branch = (body as { ref: string }).ref.replace(
                    "refs/heads/",
                    "",
                  )
                  responses[`GET ref/heads/${branch}`] = {
                    body: { object: { sha: "a".repeat(40) } },
                  }
                  responses[`PATCH refs/heads/${branch}`] = { body: {} }
                }
              },
              onGithubPullRequest: async () => {
                pullsCreated++
                await rebind?.()
              },
              onGithubPullRequestUpdate: (body: unknown) => {
                pullUpdates.push(body)
              },
            }
          : {}),
      },
      async (f) => {
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
                ...(provider === "confluence"
                  ? { cloudId: "fixture-cloud" }
                  : (provider === "linear"
                      ? encodeLinearTokensForDb
                      : encodeNotionTokensForDb)(
                      {
                        accessToken: "fixture-config-token",
                        refreshToken: null,
                      },
                      parseEnv(process.env),
                    )),
                ownerUserId: `user_${f.id}`,
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                status: "installed",
                repositoryId: repository.id,
                branch: "main",
                enabled: true,
                setupPhase: ownerFirst
                  ? "config_failed"
                  : replay
                    ? "initial_sync"
                    : "awaiting_merge",
                pendingConfigPrCreating: !replay,
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
              setupPhase: ownerFirst
                ? "config_failed"
                : replay
                  ? "live"
                  : "awaiting_merge",
              pendingConfigPrCreating: !replay,
            }),
          )
        if (upgrade) {
          await withOrgDbContext(f.org.id, (db) =>
            provider === "confluence"
              ? db
                  .update(confluenceSyncTargets)
                  .set({ setupPhase: "live", pendingConfigPrCreating: false })
                  .where(eq(confluenceSyncTargets.connectionId, connectionId))
              : db
                  .update(connections)
                  .set({
                    config: sql`(${connections.config} - 'enabled') || '{"setupPhase":"initial_sync","pendingConfigPrCreating":false}'::jsonb`,
                  })
                  .where(eq(connections.id, connectionId)),
          )
          const old = defineWorkflow<
            { orgId: string; orgSlug: string; connectionId: string },
            { changed: boolean }
          >({ name: `${provider}-sync-config` }, async () => ({
            changed: false,
          }))
          f.runner.implementWorkflow(old.spec, old.fn)
          const legacy = await f.runner.runWorkflow(
            old.spec,
            { orgId: f.org.id, orgSlug: f.org.slug, connectionId },
            provider === "confluence"
              ? {}
              : { availableAt: new Date(Date.now() + 60_000) },
          )
          if (provider === "confluence") {
            const oldWorker = f.runner.newWorker({ concurrency: 1 })
            try {
              await oldWorker.start()
              await legacy.result({ timeoutMs: 10_000 })
            } finally {
              await oldWorker.stop()
            }
          }
          const pool = new Pool({ connectionString: f.databaseUrl })
          const backend = await BackendPostgres.connect(f.databaseUrl, {
            runMigrations: false,
          })
          try {
            await backfillConnectorContentAdmissions(pool, backend, {
              orgId: f.org.id,
              connectionIds: [connectionId],
            })
            await backfillConnectorContentAdmissions(pool, backend, {
              orgId: f.org.id,
              connectionIds: [connectionId],
            })
            const read = {
              linear: getLinearBindingWithRepoByConnectionId,
              notion: getNotionBindingWithRepoByConnectionId,
              confluence: getConfluenceSyncTargetWithRepoByConnectionId,
            }[provider]
            expect(await read(f.org.id, connectionId)).toMatchObject({
              setupPhase: "initial_sync",
            })
            const children = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.filter(
              (row) =>
                (row.input as { connectionId?: string })?.connectionId ===
                  connectionId &&
                row.workflowName === `${provider}-sync-content`,
            )
            expect(children).toMatchObject([
              { status: "pending", input: { contentSyncGeneration: 1 } },
            ])
            expect(children).toHaveLength(1)
          } finally {
            await backend.stop()
            await pool.end()
            if (provider === "confluence")
              await withOrgDbContext(f.org.id, (db) =>
                db
                  .delete(confluenceSyncTargets)
                  .where(eq(confluenceSyncTargets.connectionId, connectionId)),
              )
          }
          return
        }
        let captured!: () => void
        const captureReady = new Promise<void>((resolve) => {
          captured = resolve
        })
        if (captureRestart) {
          const prior = defineWorkflow<
            LinearConfigSyncInput,
            { changed: boolean }
          >(
            { name: `${provider}-sync-config` },
            async ({ input, step, run }) => {
              await step.run({ name: "activate-config-sync" }, () =>
                activateConnectorSync({
                  purpose: "config",
                  orgId: input.orgId,
                  connectionId: input.connectionId,
                  workflowRunId: run.id,
                }),
              )
              await step.run({ name: "capture-config-binding" }, () =>
                captureConnectorConfigSyncBinding({
                  orgId: input.orgId,
                  connectionId: input.connectionId,
                  contentSyncGeneration: input.contentSyncGeneration ?? 0,
                }),
              )
              captured()
              await step.sleep("fixture-restart-boundary", "5 seconds")
              return { changed: false }
            },
          )
          f.runner.implementWorkflow(prior.spec, prior.fn)
        } else {
          f.runner.implementWorkflow(linearSyncConfig.spec, linearSyncConfig.fn)
          f.runner.implementWorkflow(notionSyncConfig.spec, notionSyncConfig.fn)
          f.runner.implementWorkflow(
            confluenceSyncConfig.spec,
            confluenceSyncConfig.fn,
          )
        }
        const command = {
          orgId: f.org.id,
          orgSlug: f.org.slug,
          connectionId,
          scopes: [],
          resources: [],
          contentSyncGeneration: ownerFirst ? 1 : 0,
          ...(ownerFirst
            ? {
                contentSyncBinding: {
                  provider,
                  repositoryId: repository.id,
                  branch: "main",
                  workspaceId:
                    provider === "confluence" ? null : "provider-workspace",
                  cloudId: provider === "confluence" ? "fixture-cloud" : null,
                  atlassianApiBaseUrl: null,
                },
              }
            : {}),
        }
        const handle =
          provider === "linear"
            ? await f.runner.runWorkflow(linearSyncConfig.spec, command, {
                deadlineAt: new Date(
                  Date.now() + (captureRestart ? 15_000 : 5000),
                ),
              })
            : provider === "notion"
              ? await f.runner.runWorkflow(notionSyncConfig.spec, command, {
                  deadlineAt: new Date(
                    Date.now() + (captureRestart ? 15_000 : 5000),
                  ),
                })
              : await f.runner.runWorkflow(confluenceSyncConfig.spec, command, {
                  deadlineAt: new Date(
                    Date.now() + (captureRestart ? 15_000 : 5000),
                  ),
                })
        if ("cancel" in scenario) {
          try {
            expect(
              await activateConnectorSync({
                purpose: "config",
                orgId: f.org.id,
                connectionId,
                workflowRunId: handle.workflowRun.id,
              }),
            ).toBe(true)
            await handle.cancel()
            const read = {
              linear: getLinearBindingWithRepoByConnectionId,
              notion: getNotionBindingWithRepoByConnectionId,
              confluence: getConfluenceSyncTargetWithRepoByConnectionId,
            }[provider]
            expect(await read(f.org.id, connectionId)).toMatchObject({
              setupPhase: "config_failed",
              pendingConfigPrCreating: false,
            })
          } finally {
            if (provider === "confluence")
              await withOrgDbContext(f.org.id, (db) =>
                db
                  .delete(confluenceSyncTargets)
                  .where(eq(confluenceSyncTargets.connectionId, connectionId)),
              )
          }
          return
        }
        if (failure)
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(repositories)
              .set({ githubConnectionId: null })
              .where(eq(repositories.id, repository.id)),
          )
        if (stale)
          await withOrgDbContext(f.org.id, (db) =>
            provider === "confluence"
              ? db
                  .update(confluenceSyncTargets)
                  .set({ enabled: false })
                  .where(eq(confluenceSyncTargets.connectionId, connectionId))
              : db
                  .update(connections)
                  .set({
                    config: sql`${connections.config} || '{"enabled":false}'::jsonb`,
                  })
                  .where(eq(connections.id, connectionId)),
          )
        rebind = async () => {
          if (provider === "confluence" && !("generationSwap" in scenario)) {
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(confluenceSyncTargets)
                .set({ branch: "another" })
                .where(eq(confluenceSyncTargets.connectionId, connectionId)),
            )
            return
          }
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(connections)
              .set({
                ...("generationSwap" in scenario
                  ? {
                      contentSyncGeneration: sql`${connections.contentSyncGeneration} + 1`,
                    }
                  : {
                      config: sql`${connections.config} || '{"branch":"another"}'::jsonb`,
                    }),
              })
              .where(eq(connections.id, connectionId)),
          )
        }
        let worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          if (captureRestart) {
            await Promise.race([
              captureReady,
              handle.result({ timeoutMs: 10_000 }).then(() => {
                throw new Error(
                  "Historical configuration completed before restart",
                )
              }),
            ])
            await worker.stop()
            await rebind()
            const resumed = new OpenWorkflow({ backend: f.backend })
            resumed.implementWorkflow(
              linearSyncConfig.spec,
              linearSyncConfig.fn,
            )
            resumed.implementWorkflow(
              notionSyncConfig.spec,
              notionSyncConfig.fn,
            )
            resumed.implementWorkflow(
              confluenceSyncConfig.spec,
              confluenceSyncConfig.fn,
            )
            worker = resumed.newWorker({ concurrency: 1 })
            await worker.start()
          }
          if (failure || stale || close || captureRestart)
            await expect(
              handle.result({ timeoutMs: captureRestart ? 18_000 : 12_000 }),
            ).rejects.toThrow()
          else
            expect(await handle.result({ timeoutMs: 12_000 })).toEqual({
              changed: false,
            })
          if (ownerFirst && !captureRestart)
            expect(
              await activateConnectorSync({
                purpose: "config",
                orgId: f.org.id,
                connectionId,
                workflowRunId: handle.workflowRun.id,
              }),
            ).toBe(true)
          const read = {
            linear: getLinearBindingWithRepoByConnectionId,
            notion: getNotionBindingWithRepoByConnectionId,
            confluence: getConfluenceSyncTargetWithRepoByConnectionId,
          }[provider]
          expect(await read(f.org.id, connectionId)).toMatchObject({
            setupPhase: failure
              ? "config_failed"
              : stale || close || captureRestart
                ? "awaiting_merge"
                : "initial_sync",
          })
          const owners = await withOrgDbContext(f.org.id, (db) =>
            db.execute(sql`
          select status, input->>'contentSyncGeneration' as generation from openworkflow.workflow_runs
          where workflow_name = ${`${provider}-sync-content`} and input->>'connectionId' = ${connectionId} and input->>'orgId' = ${f.org.id}
        `),
          )
          expect(owners.rows).toEqual(
            failure || stale || close || captureRestart
              ? []
              : [{ status: "pending", generation: ownerFirst ? "2" : "1" }],
          )
          if (close) {
            expect(pullsCreated).toBe(1)
            expect(pullUpdates.length).toBeGreaterThan(0)
            expect(
              pullUpdates.every(
                (body) => (body as { state?: string }).state === "closed",
              ),
            ).toBe(true)
          }
        } finally {
          await worker.stop()
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
