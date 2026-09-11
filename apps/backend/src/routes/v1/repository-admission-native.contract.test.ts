import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { listRepositoriesForOrg } from "../../models/repositories.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withCanceledNativeInsert } from "../../test/native-workflow-insert-failure.js"
import { atlassianConnectorRoutes } from "./connectors-atlassian.js"
import { repositoryRoutes } from "./repositories.js"

it.each(["repository", "confluence"] as const)(
  "awaits %s repository ingestion admission and retries the same saved repository",
  { timeout: 25_000 },
  async (mode) => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const connectionId = `con_${f.id}_forge`
      if (mode === "confluence") {
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
      }
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
      app.route("/:orgSlug/repositories", repositoryRoutes)
      app.route("/:orgSlug/connectors", atlassianConnectorRoutes)
      const request = () =>
        app.request(
          mode === "repository"
            ? `/${f.org.slug}/repositories`
            : `/${f.org.slug}/connectors/config?connectionId=${connectionId}`,
          {
            method: mode === "repository" ? "POST" : "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              mode === "repository"
                ? { name: "fixture/hydration-contract", gitUrl: f.workspaceUrl }
                : {
                    syncTarget: {
                      repositoryName: "fixture/hydration-contract",
                      gitUrl: f.workspaceUrl,
                      branch: "main",
                      enabled: true,
                    },
                  },
            ),
          },
        )
      try {
        const failed = await withCanceledNativeInsert(f.databaseUrl, request)
        expect(failed.status).toBe(503)
        const before = await listRepositoriesForOrg(f.org.id)
        expect(before).toHaveLength(1)
        expect(before[0]).toMatchObject({ indexingStatus: null })
        const accepted = await request()
        expect(accepted.status).toBe(mode === "repository" ? 201 : 200)
        const after = await listRepositoriesForOrg(f.org.id)
        expect(after).toHaveLength(1)
        expect(after[0]).toMatchObject({
          id: before[0]?.id,
          indexingStatus: "queued",
        })
        if (mode === "repository")
          expect(await accepted.json()).toMatchObject({
            indexingStatus: "queued",
          })
      } finally {
        if (mode === "confluence")
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(confluenceSyncTargets)
              .where(eq(confluenceSyncTargets.connectionId, connectionId)),
          )
      }
    })
  },
)
