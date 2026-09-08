import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, sql } from "drizzle-orm"
import { Client } from "pg"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import {
  encodeLinearTokensForDb,
  encodeNotionTokensForDb,
} from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { maybeActivateLinearSyncOnConfigPush } from "../webhooks/github/github-linear-push.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"
import { linearConnectorRoutes } from "./connectors-linear.js"
import { notionConnectorRoutes } from "./connectors-notion.js"

it.each([
  "linear-retry",
  "notion-retry",
  "linear-config",
  "linear-enqueue-failure",
  "linear-config-body",
  "linear-config-enqueue-failure",
  "linear-config-draft",
  "notion-config-body",
  "notion-config-enqueue-failure",
  "notion-config-draft",
  "notion-config-save",
  "linear-config-save",
] as const)(
  "admits a durable content owner through the native %s boundary",
  { timeout: 30_000 },
  async (mode) => {
    const provider = mode.startsWith("notion") ? "notion" : "linear"
    const webhook =
      mode === "linear-config" || mode === "linear-enqueue-failure"
    const proposal = mode.includes("config-")
    const save = mode.endsWith("config-save")
    const draft = mode.endsWith("draft")
    const config =
      "version: 1\nsource: linear\nworkspace:\n  id: provider-workspace\n  name: Fixture\nscope: {}\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubContentFiles: {
          "linear/config.yaml": draft
            ? "version: 1\nsource: linear\nworkspace:\n  id: provider-workspace\n  name: Fixture\nscope:\n  teams:\n    - id: team-a\n      name: A\n      key: A\n"
            : config,
          "notion/config.yaml": draft
            ? "version: 1\nsource: notion\nresources:\n  - id: page-a\n    type: page\n    title: A\n"
            : "version: 1\nsource: notion\nresources: []\n",
        },
        githubPullRequest: {
          number: 41,
          head: { ref: "ctxpipe/config-draft" },
          state: "open",
          html_url: "https://github.com/fixture/hydration-contract/pull/41",
        },
      },
      async (f) => {
        const env = parseEnv(process.env)
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_${provider}`
        const encode =
          provider === "linear"
            ? encodeLinearTokensForDb
            : encodeNotionTokensForDb
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: provider,
              config: {
                ...encode(
                  {
                    accessToken: "fixture-content-admission-token",
                    refreshToken: null,
                  },
                  env,
                ),
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                ownerUserId: `user_${f.id}`,
                status: "installed",
                repositoryId: repository.id,
                branch: "main",
                enabled: true,
                setupPhase: webhook
                  ? "awaiting_merge"
                  : proposal
                    ? save
                      ? "live"
                      : "config_failed"
                    : "sync_failed",
                pendingConfigPullUrl: draft
                  ? "https://github.com/fixture/hydration-contract/pull/41"
                  : null,
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        if (webhook) {
          const [github] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select()
              .from(connections)
              .where(eq(connections.id, f.connectionId)),
          )
          if (!github) throw new Error("Fixture GitHub connection missing")
          await upsertConnectionDirectory(github)
          const deliver = () =>
            maybeActivateLinearSyncOnConfigPush({
              installationId: 123456789,
              githubConnectionId: f.connectionId,
              repoFullName: "fixture/hydration-contract",
              ref: "refs/heads/main",
              commits: [{ modified: ["linear/config.yaml"] }],
              log: { error: () => undefined },
            })
          if (mode === "linear-enqueue-failure") {
            expect(
              await withCanceledNativeInsert(f.databaseUrl, () =>
                deliver().then(
                  () => false,
                  () => true,
                ),
              ),
            ).toBe(true)
          }
          await deliver()
          await deliver()
        } else {
          const app = new OpenAPIHono<AppEnv>()
          app.use(contextStorage())
          app.use(withTestRequestLogger)
          app.use("*", async (c, next) => {
            c.set("user", { id: `user_${f.id}` } as AppEnv["Variables"]["user"])
            c.set("session", {
              id: `sess_${f.id}`,
            } as AppEnv["Variables"]["session"])
            c.set("orgId", f.org.id)
            c.set("env", env)
            await withOrgIdContext(f.org, next)
          })
          app.route(
            "/:orgSlug/connectors",
            provider === "linear"
              ? linearConnectorRoutes
              : notionConnectorRoutes,
          )
          const request = (title = "B", reordered = false) =>
            app.request(
              `/${f.org.slug}/connectors/${save ? "config" : proposal ? "retry-config" : "retry"}?connectionId=${connectionId}`,
              {
                method: save ? "PATCH" : "POST",
                ...(!draft && proposal
                  ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(
                        provider === "linear"
                          ? {
                              scopes: (reordered
                                ? ["team-c", "team-b"]
                                : ["team-b", "team-c"]
                              ).map((externalId) => ({
                                externalId,
                                type: "team",
                                title,
                                url: null,
                                parentExternalId: null,
                                teamId: "team-b",
                                teamKey: "B",
                              })),
                            }
                          : {
                              resources: (reordered
                                ? ["page-c", "page-b"]
                                : ["page-b", "page-c"]
                              ).map((externalId) => ({
                                externalId,
                                url: reordered
                                  ? "https://notion.so/updated"
                                  : null,
                                type: "page",
                                title,
                              })),
                            },
                      ),
                    }
                  : {}),
              },
            )
          if (proposal && mode.endsWith("enqueue-failure")) {
            const failed = await withCanceledNativeInsert(
              f.databaseUrl,
              request,
            )
            expect(failed.status).toBe(503)
            const read =
              provider === "linear"
                ? getLinearBindingWithRepoByConnectionId
                : getNotionBindingWithRepoByConnectionId
            expect(await read(f.org.id, connectionId)).toMatchObject({
              setupPhase: "config_failed",
            })
          }
          const responses = proposal
            ? [await request()]
            : await Promise.all([request(), request()])
          const response =
            responses.find((r) => r.status === (save ? 200 : 202)) ??
            responses[0]
          if (!response) throw new Error("Native HTTP response missing")
          expect({
            status: response.status,
            body: await response.json(),
          }).toMatchObject({
            status: save ? 200 : 202,
            body: save ? { configPrEnqueued: true } : { accepted: true },
          })
          if (!proposal)
            expect(
              responses.every((r) => [202, 400, 409].includes(r.status)),
            ).toBe(true)
          if (save) {
            const repeated = await request()
            expect(repeated.status).toBe(200)
            expect(await repeated.json()).toMatchObject({
              configPrEnqueued: false,
            })
            const reordered = await request("B", true)
            expect(reordered.status).toBe(200)
            expect(await reordered.json()).toMatchObject({
              configPrEnqueued: false,
            })
            const competing = await request("Different proposal")
            expect(competing.status).toBe(409)
          }
        }
        const read =
          provider === "linear"
            ? getLinearBindingWithRepoByConnectionId
            : getNotionBindingWithRepoByConnectionId
        expect(await read(f.org.id, connectionId)).toMatchObject({
          setupPhase: proposal ? "awaiting_merge" : "initial_sync",
        })
        const owners = await withOrgDbContext(f.org.id, (db) =>
          db.execute(sql`
        select workflow_name, status, input->>'contentSyncGeneration' as generation
        from openworkflow.workflow_runs where input->>'orgId' = ${f.org.id} and input->>'connectionId' = ${connectionId}
      `),
        )
        expect(owners.rows).toEqual([
          {
            workflow_name: `${provider}-sync-${proposal ? "config" : "content"}`,
            status: "pending",
            generation: "1",
          },
        ])
      },
    )
  },
)

/** Real PostgreSQL transport failure before the native INSERT can commit. */
async function withCanceledNativeInsert<T>(
  databaseUrl: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const locker = new Client({ connectionString: databaseUrl })
  await locker.connect()
  let pending: Promise<T> | undefined
  try {
    await locker.query("BEGIN")
    await locker.query("LOCK TABLE openworkflow.workflow_runs IN SHARE MODE")
    const lockPid = (
      await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid
    if (!lockPid) throw new Error("Fixture lock PID missing")
    pending = Promise.resolve(operation())
    void pending.catch(() => undefined)
    let blockedPid: number | undefined
    await expect
      .poll(
        async () => {
          await locker.query("SELECT pg_stat_clear_snapshot()")
          const rows = await locker.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%INSERT INTO%' AND query LIKE '%workflow_runs%'",
            [lockPid],
          )
          blockedPid = rows.rows[0]?.pid
          return blockedPid != null
        },
        { timeout: 5000 },
      )
      .toBe(true)
    await locker.query("SELECT pg_cancel_backend($1)", [blockedPid])
    return await pending
  } finally {
    await locker.query("ROLLBACK")
    await locker.end()
    await pending?.catch(() => undefined)
  }
}

it.each(["spaces", "target", "enqueue-failure", "disabled"] as const)(
  "admits a native Confluence proposal through HTTP (%s)",
  { timeout: 30_000 },
  async (mode) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_forge`
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "forge",
              config: { status: "installed", cloudId: "fixture-cloud" },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        await withOrgDbContext(f.org.id, async (db) => {
          await db.insert(confluenceSyncTargets).values({
            id: `cst_${f.id}`,
            orgId: f.org.id,
            connectionId,
            repositoryId: repository.id,
            branch: "main",
            enabled: true,
            setupPhase: "draft",
          })
          await db.insert(confluenceSpaces).values({
            id: `csp_${f.id}`,
            orgId: f.org.id,
            connectionId,
            spaceKey: "ENG",
            spaceName: "Engineering",
            selectedPageIds: null,
          })
        })
        try {
          const app = new OpenAPIHono<AppEnv>()
          app.use(contextStorage())
          app.use(withTestRequestLogger)
          app.use("*", async (c, next) => {
            c.set("user", { id: `user_${f.id}` } as AppEnv["Variables"]["user"])
            c.set("session", {
              id: `sess_${f.id}`,
            } as AppEnv["Variables"]["session"])
            c.set("orgId", f.org.id)
            c.set("env", parseEnv(process.env))
            await withOrgIdContext(f.org, next)
          })
          app.route("/:orgSlug/connectors", atlassianConnectorRoutes)
          const url = `/${f.org.slug}/connectors/config?connectionId=${connectionId}`
          const request = (spaceKey = "ENG", reordered = false) =>
            app.request(url, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                mode === "target" || mode === "disabled"
                  ? {
                      syncTarget: {
                        repositoryId: repository.id,
                        branch: "main",
                        enabled: mode !== "disabled",
                      },
                    }
                  : {
                      spaces: [
                        {
                          spaceKey,
                          spaceName: "Engineering",
                          selectedPageIds:
                            mode === "spaces"
                              ? reordered
                                ? ["page-2", "page-1"]
                                : ["page-1", "page-2"]
                              : null,
                        },
                      ],
                    },
              ),
            })
          if (mode === "enqueue-failure") {
            expect(
              (await withCanceledNativeInsert(f.databaseUrl, request)).status,
            ).toBe(503)
            expect(await (await app.request(url)).json()).toMatchObject({
              syncTarget: { setupPhase: "draft" },
            })
          }
          const accepted = await request()
          if (mode === "disabled") {
            expect(accepted.status).toBe(200)
            expect(await accepted.json()).toMatchObject({
              configPrEnqueued: false,
            })
            expect(await (await app.request(url)).json()).toMatchObject({
              syncTarget: { enabled: false, setupPhase: "draft" },
            })
            const owners = await withOrgDbContext(f.org.id, (db) =>
              db.execute(
                sql`select id from openworkflow.workflow_runs where input->>'connectionId' = ${connectionId} and input->>'orgId' = ${f.org.id}`,
              ),
            )
            expect(owners.rows).toEqual([])
            return
          }
          expect({
            status: accepted.status,
            body: await accepted.json(),
          }).toMatchObject({ status: 200, body: { configPrEnqueued: true } })
          const repeated = await request()
          expect({
            status: repeated.status,
            body: await repeated.json(),
          }).toMatchObject({ status: 200, body: { configPrEnqueued: false } })
          if (mode === "spaces") {
            const reordered = await request("ENG", true)
            expect(reordered.status).toBe(200)
            expect(await reordered.json()).toMatchObject({
              configPrEnqueued: false,
            })
            expect((await request("DIFFERENT")).status).toBe(409)
            expect(await (await app.request(url)).json()).toMatchObject({
              spaces: [{ spaceKey: "ENG" }],
            })
          }
          expect(await (await app.request(url)).json()).toMatchObject({
            syncTarget: {
              setupPhase: "awaiting_merge",
              pendingConfigPrCreating: true,
            },
          })
          const owners = await withOrgDbContext(f.org.id, (db) =>
            db.execute(
              sql`select workflow_name, input from openworkflow.workflow_runs where input->>'connectionId' = ${connectionId} and input->>'orgId' = ${f.org.id}`,
            ),
          )
          expect(owners.rows).toMatchObject([
            {
              workflow_name: "confluence-sync-config",
              input: {
                contentSyncGeneration: 1,
                spaces: [
                  {
                    spaceKey: "ENG",
                    selectedPageIds:
                      mode === "spaces" ? ["page-1", "page-2"] : null,
                  },
                ],
              },
            },
          ])
          expect(owners.rows).toHaveLength(1)
        } finally {
          await withOrgDbContext(f.org.id, async (db) => {
            await db
              .delete(confluenceSpaces)
              .where(eq(confluenceSpaces.connectionId, connectionId))
            await db
              .delete(confluenceSyncTargets)
              .where(eq(confluenceSyncTargets.connectionId, connectionId))
          })
        }
      },
    )
  },
)
