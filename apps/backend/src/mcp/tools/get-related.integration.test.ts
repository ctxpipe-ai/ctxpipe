import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { servePlaneHead } from "../../test/knowledge-plane.js"
import { seedServedWorkspace } from "../../test/knowledge-search-fixture.js"
import { callTool, connectToolClient } from "../../test/mcp-tool-client.js"
import { TOOL_ERROR_META_KEY } from "../framework/tool-result.js"
import { getRelatedTool } from "./get-related.js"

/*
 * The arguments and the readiness checks of `get_related` through the MCP
 * client, on real Postgres. Each call here ends before the knowledge plane
 * reads ClickHouse. The rankings of the plane are in
 * `knowledge-reader.integration.test.ts`.
 */

const checkout = "knowledge/services/checkout-api.md"
const sha = (letter: string) => letter.repeat(40)

let seed: SeededOrg
let client: Client

const related = (args: Record<string, unknown>) =>
  callTool(client, "get_related", { org: seed.orgSlug, ...args })

const errorCode = (result: CallToolResult): unknown => {
  expect(result.isError).toBe(true)
  return (result._meta?.[TOOL_ERROR_META_KEY] as { code?: string })?.code
}

describe("get_related arguments and readiness through the MCP client", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    // No ClickHouse: a call that reaches the plane fails.
    vi.stubEnv("CLICKHOUSE_URL", undefined)
    seed = await seedOrg()
    const { workspaceId } = await seedServedWorkspace({
      seed,
      slug: "payments",
      sha: sha("b"),
    })
    await servePlaneHead({ orgId: seed.orgId, workspaceId, tip: sha("b") })
    // A published Workspace that the plane does not serve yet.
    await seedServedWorkspace({ seed, slug: "building", sha: sha("c") })
    client = await connectToolClient(seed, getRelatedTool)
  }, 60_000)
  afterAll(async () => {
    await client?.close()
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await cleanupSeededOrg(seed)
    }
    vi.unstubAllEnvs()
  })

  it("refuses bad arguments with a code the agent can act on", async () => {
    expect(
      errorCode(await related({ workspace: "missing", seeds: [checkout] })),
    ).toBe("workspace_not_found")
    expect(
      errorCode(
        await callTool(client, "get_related", {
          org: "no-such-org",
          workspace: "payments",
          seeds: [checkout],
        }),
      ),
    ).toBe("org_not_found")
    expect(
      errorCode(
        await related({
          workspace: "payments",
          seeds: [checkout],
          validAt: "2026-10-14T00:00:00Z",
          validBetween: {
            from: "2026-06-15T00:00:00Z",
            to: "2026-06-20T00:00:00Z",
          },
        }),
      ),
    ).toBe("invalid_argument")
  })

  it("refuses an option that is out of range", async () => {
    for (const bad of [
      { maxFanOut: 4 },
      { maxFanOut: 201 },
      { maxDepth: 5 },
      { minConfidence: 1.1 },
      { limit: 51 },
    ]) {
      // The schema refuses the call before the tool runs: the result names
      // the field, and the tool gives no code of its own.
      const result = await related({
        workspace: "payments",
        seeds: [checkout],
        ...bad,
      })
      expect(result.isError, JSON.stringify(bad)).toBe(true)
      expect(result._meta?.[TOOL_ERROR_META_KEY], JSON.stringify(bad)).toBe(
        undefined,
      )
      expect(JSON.stringify(result.content), JSON.stringify(bad)).toContain(
        Object.keys(bad)[0],
      )
    }
  })

  it("gives workspace_not_ready for a Workspace with no published revision or no knowledge projection yet", async () => {
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: `ws_rel_legacy_${Date.now()}`,
        orgId: seed.orgId,
        slug: "legacy",
        displayName: "Legacy",
        workspaceRepositoryUrl: "https://git.example.test/acme/legacy.git",
        desiredDefaultBranch: "main",
        activeProjectionSha: sha("e"),
      })
      await db.insert(workspaces).values({
        id: `ws_rel_empty_${Date.now()}`,
        orgId: seed.orgId,
        slug: "empty",
        displayName: "Empty",
        workspaceRepositoryUrl: "https://git.example.test/acme/empty.git",
      })
    })
    for (const slug of ["legacy", "empty", "building"]) {
      const result = await related({ workspace: slug, seeds: [checkout] })
      expect(errorCode(result), slug).toBe("workspace_not_ready")
      expect(result._meta?.[TOOL_ERROR_META_KEY]).toMatchObject({
        retryable: true,
      })
    }
    const building = await related({ workspace: "building", seeds: [checkout] })
    expect(JSON.stringify(building.content)).toContain("still building")
  })

  it("gives invalid_argument for a named branch with no knowledge projection", async () => {
    const result = await related({
      workspace: "payments",
      branch: "feature",
      seeds: [checkout],
    })
    expect(errorCode(result)).toBe("invalid_argument")
    expect(JSON.stringify(result.content)).toContain(
      "The branch feature has no knowledge projection",
    )
  })
})
