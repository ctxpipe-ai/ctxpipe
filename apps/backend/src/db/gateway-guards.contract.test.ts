import { expect, it } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "./client.js"
import { enqueueWorkspaceIndex } from "../openworkflow/enqueue-workspace-index.js"

it("rejects outbound workflow enqueue inside a real PostgreSQL transaction", async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
  initDb(process.env.DATABASE_URL)
  try {
    await expect(
      withOrgDbContext("org_gateway_proof", () =>
        enqueueWorkspaceIndex(
          {
            orgId: "org_gateway_proof",
            revision: {
              workspaceId: "ws_gateway_proof",
              generation: 1,
              remote: {
                url: "https://example.test/repo.git",
                connectionId: null,
              },
              sha: "a".repeat(40),
              defaultBranch: "main",
              access: "read",
            },
          },
          { error: () => undefined },
        ),
      ),
    ).rejects.toThrow(/Outbound I\/O/)
  } finally {
    await closeDb()
  }
})
