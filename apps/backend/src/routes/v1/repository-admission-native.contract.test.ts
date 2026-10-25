import { OpenAPIHono } from "@hono/zod-openapi"
import { expect, it } from "vitest"

import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { listRepositoriesForOrg } from "../../models/repositories.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withCanceledNativeInsert } from "../../test/native-workflow-insert-failure.js"
import { repositoryRoutes } from "./repositories.js"

it(
  "awaits repository ingestion admission and retries the same saved repository",
  { timeout: 25_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
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
      const request = () =>
        app.request(`/${f.org.slug}/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "fixture/hydration-contract",
            gitUrl: f.workspaceUrl,
          }),
        })
      const failed = await withCanceledNativeInsert(f.databaseUrl, request)
      expect(failed.status).toBe(503)
      const before = await listRepositoriesForOrg(f.org.id)
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ indexingStatus: null })
      const accepted = await request()
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ indexingStatus: "queued" })
      const after = await listRepositoriesForOrg(f.org.id)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({
        id: before[0]?.id,
        indexingStatus: "queued",
      })
    })
  },
)
