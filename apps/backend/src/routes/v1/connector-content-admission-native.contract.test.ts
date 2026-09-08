import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
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
import { linearConnectorRoutes } from "./connectors-linear.js"
import { notionConnectorRoutes } from "./connectors-notion.js"

it.each([
  "linear-retry",
  "notion-retry",
  "linear-config",
  "linear-config-body",
  "linear-config-draft",
  "notion-config-body",
  "notion-config-draft",
  "notion-config-save",
] as const)(
  "admits a durable content owner through the native %s boundary",
  { timeout: 30_000 },
  async (mode) => {
    const provider = mode.startsWith("notion") ? "notion" : "linear"
    const proposal = mode.includes("config-")
    const save = mode === "notion-config-save"
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
                setupPhase:
                  mode === "linear-config"
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
        if (mode === "linear-config") {
          const [github] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select()
              .from(connections)
              .where(eq(connections.id, f.connectionId)),
          )
          if (!github) throw new Error("Fixture GitHub connection missing")
          await upsertConnectionDirectory(github)
          for (let delivery = 0; delivery < 2; delivery++)
            await maybeActivateLinearSyncOnConfigPush({
              installationId: 123456789,
              githubConnectionId: f.connectionId,
              repoFullName: "fixture/hydration-contract",
              ref: "refs/heads/main",
              commits: [{ modified: ["linear/config.yaml"] }],
              log: {
                error: (error) => {
                  throw error
                },
              },
            })
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
          const request = () =>
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
                              scopes: [
                                {
                                  externalId: "team-b",
                                  type: "team",
                                  title: "B",
                                  url: null,
                                  parentExternalId: null,
                                  teamId: "team-b",
                                  teamKey: "B",
                                },
                              ],
                            }
                          : {
                              resources: [
                                {
                                  externalId: "page-b",
                                  type: "page",
                                  title: "B",
                                },
                              ],
                            },
                      ),
                    }
                  : {}),
              },
            )
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
