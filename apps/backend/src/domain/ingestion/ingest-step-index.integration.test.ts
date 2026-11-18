import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { stepIndexProjection } from "./ingest-shard-sandbox.js"

let ctx: Awaited<ReturnType<typeof seedSourcesOrg>>
let workspaceId: string
const sha = "a".repeat(40)

describe("step index projection (Postgres, runtime role)", () => {
  beforeAll(async () => {
    ctx = await seedSourcesOrg("stepidx")
    workspaceId = await ctx.addWorkspace("stepidx")
    await withOrgDbContext(ctx.orgId, async (db) => {
      // The unit rows belong to the active projection of the Workspace.
      await db
        .update(workspaces)
        .set({ activeProjectionSha: sha })
        .where(eq(workspaces.id, workspaceId))
      await db.insert(workspaceKnowledgeUnits).values({
        servingId: `serving_${ctx.suffix}`,
        orgId: ctx.orgId,
        workspaceId,
        path: "knowledge/services/api.md",
        kind: "Service",
        body: "Body.\n",
        projectionSha: sha,
        links: ["knowledge/guides/plain.md"],
      })
    })
  })
  afterAll(() => ctx.cleanup())

  it("reads the units of the pinned revision with no outer org context", async () => {
    // The DATABASE_URL role is ctxpipe_app, which RLS binds to one org.
    expect(await stepIndexProjection(ctx.orgId, workspaceId, sha)).toEqual([
      {
        path: "knowledge/services/api.md",
        kind: "Service",
        links: ["knowledge/guides/plain.md"],
      },
    ])
  })
})
