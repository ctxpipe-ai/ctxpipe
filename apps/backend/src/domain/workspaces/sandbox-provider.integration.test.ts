import { initLogger } from "evlog"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { refuseVercelSandboxRows } from "./sandbox-provider.js"

/*
 * The backend and the worker refuse to start while a sandbox row of the
 * removed Vercel provider stays. Each case writes its rows in one org
 * transaction and rolls it back, so no other test or process sees a
 * `vercel` row (the worker config check reads every org).
 */

const events: Record<string, unknown>[] = []

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the startup check")
  initDb(url)
  // setup-evlog turns evlog off; this file reads the drained events.
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
    silent: true,
    drain: (ctx) => {
      events.push(ctx.event as Record<string, unknown>)
    },
  })
})
afterAll(async () => {
  await closeDb()
})
beforeEach(() => {
  events.length = 0
})

function refusalEvents() {
  return events.filter((event) => event.step === "vercel-sandbox-rows")
}

class RolledBack extends Error {}

/** Runs `check` in a new org with sandbox rows of these providers, then rolls back. */
async function withSandboxRows(
  providers: string[],
  check: (ids: { orgId: string; sandboxIds: string[] }) => Promise<void>,
): Promise<void> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const sandboxIds = providers.map(() => generateObjectId("sbx"))
  await expect(
    withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: "https://example.test/context.git",
      })
      if (providers.length)
        await db.insert(workspaceSandboxInstances).values(
          providers.map((provider, index) => ({
            id: sandboxIds[index] ?? "",
            kind: "chat" as const,
            orgId,
            workspaceId,
            conversationId: generateObjectId("conv"),
            provider,
            providerSandboxId: `sbx-old-${index}`,
            state: "stopped" as const,
            lastHeartbeatAt: new Date(),
          })),
        )
      await check({ orgId, sandboxIds })
      throw new RolledBack()
    }),
  ).rejects.toBeInstanceOf(RolledBack)
}

describe("refuseVercelSandboxRows (Postgres)", () => {
  it("refuses the start with one Vercel row, and names no identifier", async () => {
    await withSandboxRows(
      ["vercel", "docker"],
      async ({ orgId, sandboxIds }) => {
        const refusal = await refuseVercelSandboxRows([orgId]).then(
          () => null,
          (error: unknown) => error,
        )
        expect(refusal).toBeInstanceOf(Error)
        const message = (refusal as Error).message
        expect(message).toContain("(count: 1)")
        expect(message).toContain("retireVercelSandboxes.ts")
        const refusalLogs = refusalEvents()
        expect(refusalLogs).toMatchObject([
          { level: "error", step: "vercel-sandbox-rows", message, rows: 1 },
        ])
        for (const id of [orgId, ...sandboxIds, "sbx-old-0"]) {
          expect(message).not.toContain(id)
          expect(JSON.stringify(refusalLogs)).not.toContain(id)
        }
      },
    )
  })

  it("passes with no Vercel row", async () => {
    await withSandboxRows(["docker", "agentcore"], async ({ orgId }) => {
      await expect(refuseVercelSandboxRows([orgId])).resolves.toBeUndefined()
    })
    expect(refusalEvents()).toEqual([])
  })
})
