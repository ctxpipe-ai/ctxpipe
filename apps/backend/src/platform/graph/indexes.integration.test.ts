/**
 * Checks that the configured graph engine accepts the node id index statement
 * and tolerates it running again (a fresh process repeats it).
 * Requires GRAPH_DB_URI (set in .env.local; `pnpm dev:infra` starts FalkorDB).
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { afterAll, describe, expect, it, vi } from "vitest"

const warnMock = vi.hoisted(() => vi.fn())
vi.mock("../../observability/logger.js", () => ({
  log: { warn: warnMock, error: vi.fn(), info: vi.fn() },
}))

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const graphUri = process.env.GRAPH_DB_URI
const orgId = `org_eval_indexes_${Date.now()}`
const orgSlug = "traversal-eval"

async function ensureInFreshProcess(kinds: string[]): Promise<void> {
  vi.resetModules()
  const client = await import("./client.js")
  const { ensureNodeIdIndexes } = await import("./indexes.js")
  await client.withGraphClient({ orgId, orgSlug }, () =>
    ensureNodeIdIndexes(orgId, kinds),
  )
  await client.closeGraphDb()
}

describe.skipIf(!graphUri)("node id indexes (live graph engine)", () => {
  afterAll(async () => {
    vi.resetModules()
    const client = await import("./client.js")
    if (client.getConfig().provider === "falkordb") {
      const { FalkorDB } = await import("falkordb")
      const db = await FalkorDB.connect({ url: graphUri })
      await db
        .selectGraph(orgId)
        .delete()
        .catch(() => undefined)
      await db.close()
    }
  })

  it("creates the index, and a repeat is not reported as a failure", async () => {
    await ensureInFreshProcess(["EvalIndexedKind"])
    await ensureInFreshProcess(["EvalIndexedKind"])

    expect(warnMock).not.toHaveBeenCalled()
  })
})
