import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { seedServedWorkspace } from "../../test/knowledge-search-fixture.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

/*
 * The knowledge tools of the Workspace chat on real Postgres: a Workspace
 * that the knowledge plane does not serve yet gives the model a message to
 * try again later (`knowledge_building`), not an error.
 */

const sha = "e".repeat(40)
let seed: SeededOrg
let tools: Awaited<ReturnType<typeof workspaceChatTools>>

const run = async (name: string, args: Record<string, unknown>) => {
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return String(await found.execute(args))
}

describe("the knowledge tools of the Workspace chat before the knowledge plane serves the Workspace", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    const { workspaceId, revision } = await seedServedWorkspace({
      seed,
      slug: "building",
      sha,
    })
    tools = await workspaceChatTools({
      orgId: seed.orgId,
      workspaceId,
      snapshot: {
        projection: {
          kind: "active",
          revision,
          stores: { index: { kind: "ready" } },
        },
        units: [],
        repositories: [],
      },
    })
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
    )
    await cleanupSeededOrg(seed)
  })

  it("hybrid_search tells the model to try again in a few minutes", async () => {
    expect(await run("hybrid_search", { query: "billing" })).toBe(
      "The Workspace knowledge is being built. Use the other tools now, and try the knowledge tools again in a few minutes.",
    )
  })

  it.each([
    ["graph_lookup", { nodeId: "kn_1" }],
    ["graph_neighbors", { nodeId: "kn_1" }],
  ])("%s gives knowledge_building", async (name, args) => {
    const text = await run(name, args)
    expect(text).toContain("knowledge_building")
    expect(text).toContain("try the knowledge tools again in a few minutes")
  })
})
