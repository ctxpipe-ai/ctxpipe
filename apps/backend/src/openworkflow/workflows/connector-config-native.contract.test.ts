import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
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
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { confluenceSyncConfig } from "./confluence-sync-config.js"
import { linearSyncConfig } from "./linear-sync-config.js"
import { notionSyncConfig } from "./notion-sync-config.js"

it.each(
  (["linear", "notion", "confluence"] as const).flatMap((provider) => [
    { provider, failure: false, stale: false, close: false },
    { provider, failure: true, stale: false, close: false },
    { provider, failure: false, stale: true, close: false },
    ...(provider === "linear"
      ? [{ provider, failure: false, stale: false, close: true }]
      : []),
  ]),
)(
  "native $provider config admission (failure=$failure; stale=$stale; close=$close)",
  { timeout: 30_000 },
  async ({ provider, failure, stale, close }) => {
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
                setupPhase: "awaiting_merge",
                pendingConfigPrCreating: true,
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
              setupPhase: "awaiting_merge",
              pendingConfigPrCreating: true,
            }),
          )
        f.runner.implementWorkflow(linearSyncConfig.spec, linearSyncConfig.fn)
        f.runner.implementWorkflow(notionSyncConfig.spec, notionSyncConfig.fn)
        f.runner.implementWorkflow(
          confluenceSyncConfig.spec,
          confluenceSyncConfig.fn,
        )
        const command = {
          orgId: f.org.id,
          orgSlug: f.org.slug,
          connectionId,
          scopes: [],
          resources: [],
        }
        const handle =
          provider === "linear"
            ? await f.runner.runWorkflow(linearSyncConfig.spec, command, {
                deadlineAt: new Date(Date.now() + 5000),
              })
            : provider === "notion"
              ? await f.runner.runWorkflow(notionSyncConfig.spec, command, {
                  deadlineAt: new Date(Date.now() + 5000),
                })
              : await f.runner.runWorkflow(confluenceSyncConfig.spec, command, {
                  deadlineAt: new Date(Date.now() + 5000),
                })
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
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(connections)
              .set({
                config: sql`${connections.config} || '{"branch":"another"}'::jsonb`,
              })
              .where(eq(connections.id, connectionId)),
          )
        }
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          if (failure || stale || close)
            await expect(handle.result({ timeoutMs: 12_000 })).rejects.toThrow()
          else
            expect(await handle.result({ timeoutMs: 12_000 })).toEqual({
              changed: false,
            })
          const read = {
            linear: getLinearBindingWithRepoByConnectionId,
            notion: getNotionBindingWithRepoByConnectionId,
            confluence: getConfluenceSyncTargetWithRepoByConnectionId,
          }[provider]
          expect(await read(f.org.id, connectionId)).toMatchObject({
            setupPhase: failure
              ? "config_failed"
              : stale || close
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
            failure || stale || close
              ? []
              : [{ status: "pending", generation: "1" }],
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
