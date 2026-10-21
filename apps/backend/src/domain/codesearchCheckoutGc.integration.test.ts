import { randomBytes } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  collectRepositoryCheckouts,
  listCollectableCheckouts,
} from "./codesearchCheckoutGc.js"

const sha = () => randomBytes(20).toString("hex")
const orgId = generateObjectId("org")
const repositoryId = generateObjectId("repo")
const workspaceId = generateObjectId("ws")
const goneWorkspaceId = generateObjectId("ws")
const parentRunId = `run_${sha()}`
const childRunId = `run_${sha()}`
const codesearchUrl = "http://codesearch.test"

const published = sha()
const shas = {
  old: sha(),
  live: sha(),
  child: sha(),
  wsCurrent: sha(),
  wsOld: sha(),
  wsGone: sha(),
  fresh: sha(),
}
const keys = {
  default: "default",
  published: `rev:${published}`,
  old: `rev:${shas.old}`,
  live: `rev:${shas.live}`,
  child: `rev:${shas.child}`,
  wsLegacy: `ws:${workspaceId}`,
  wsCurrent: `ws:${workspaceId}:${shas.wsCurrent}`,
  wsOld: `ws:${workspaceId}:${shas.wsOld}`,
  wsGone: `ws:${goneWorkspaceId}:${shas.wsGone}`,
  fresh: `rev:${shas.fresh}`,
}
const deleteRequests: string[][] = []
const codesearch = setupServer(
  http.post(
    `${codesearchUrl}/${repositoryId}/checkouts/delete`,
    async ({ request }) => {
      const { checkoutKeys } = (await request.json()) as {
        checkoutKeys: string[]
      }
      deleteRequests.push(checkoutKeys)
      return HttpResponse.json({
        deleted: checkoutKeys
          .filter((key) => key !== keys.wsGone)
          .map((checkoutKey) => ({ checkoutKey, bytes: 1000 })),
        skipped: checkoutKeys
          .filter((key) => key === keys.wsGone)
          .map((checkoutKey) => ({ checkoutKey, reason: "not_found" })),
      })
    },
  ),
)

async function storedKeys() {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({ key: repositoryCheckouts.checkoutKey })
      .from(repositoryCheckouts)
      .where(eq(repositoryCheckouts.repositoryId, repositoryId)),
  )
  return rows.map((row) => row.key).sort()
}

describeWithDatabase("codesearch checkout collection (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is unset")
    vi.stubEnv("AUTH_SECRET", "ci-auth-secret-must-be-at-least-32-chars")
    vi.stubEnv("CODESEARCH_URL", codesearchUrl)
    codesearch.listen({ onUnhandledRequest: "error" })
    initDb(process.env.DATABASE_URL)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "Checkout collection",
        slug: `checkout-gc-${orgId}`,
        createdAt: new Date(),
      })
    const old = new Date(Date.now() - 2 * 3_600_000)
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: `example/gc-${repositoryId}`,
        gitUrl: `https://github.com/example/gc-${repositoryId}.git`,
        lastIngestedHash: published,
      })
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `gc-${workspaceId}`,
        displayName: "Checkout collection",
        workspaceRepositoryUrl: `https://github.com/example/ws-${workspaceId}.git`,
        indexedSha: shas.wsCurrent,
      })
      await db.insert(repositoryCheckouts).values(
        Object.values(keys).map((checkoutKey) => ({
          id: generateObjectId("co"),
          orgId,
          repositoryId,
          checkoutKey,
          createdAt: checkoutKey === keys.fresh ? new Date() : old,
          updatedAt: checkoutKey === keys.fresh ? new Date() : old,
        })),
      )
    })
    // A running ingestion, and the finished index child run of another
    // running parent: their SHAs are still in use.
    const ns = openWorkflowNamespaceId()
    const now = new Date().toISOString()
    await getSystemDb().execute(sql`
      insert into openworkflow.workflow_runs
        (namespace_id, id, workflow_name, status, config, input, attempts, created_at, updated_at)
      values
        (${ns}, ${parentRunId}, 'repository-ingestion', 'running', '{}'::jsonb,
          ${JSON.stringify({ orgId, repositoryId, targetHash: shas.live })}::jsonb, 1, ${now}, ${now}),
        (${ns}, ${childRunId}, 'repository-index', 'completed', '{}'::jsonb,
          ${JSON.stringify({ orgId, repositoryId, targetHash: shas.child })}::jsonb, 1, ${now}, ${now})
    `)
    await getSystemDb().execute(sql`
      insert into openworkflow.step_attempts
        (namespace_id, id, workflow_run_id, step_name, kind, status, config,
          child_workflow_run_namespace_id, child_workflow_run_id, created_at, updated_at)
      values (${ns}, ${`step_${sha()}`}, ${parentRunId}, 'repository-index', 'workflow',
        'running', '{}'::jsonb, ${ns}, ${childRunId}, ${now}, ${now})
    `)
  })

  afterAll(async () => {
    codesearch.close()
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where id in (${parentRunId}, ${childRunId})`,
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("keeps the published, running, current Workspace, recent, and default checkouts", async () => {
    const collectable = await listCollectableCheckouts(orgId, repositoryId)

    expect(collectable.map((row) => row.checkoutKey).sort()).toEqual(
      [keys.old, keys.wsOld, keys.wsGone].sort(),
    )
  })

  it("deletes the rows of the checkouts that codesearch deleted", async () => {
    const result = await collectRepositoryCheckouts({ orgId, repositoryId })

    expect(deleteRequests).toHaveLength(1)
    expect(result).toEqual({ deletedKeys: 2, bytesFreed: 2000 })
    expect(await storedKeys()).toEqual(
      [
        keys.default,
        keys.published,
        keys.live,
        keys.child,
        keys.wsLegacy,
        keys.wsCurrent,
        keys.wsGone,
        keys.fresh,
      ].sort(),
    )
  })
})
