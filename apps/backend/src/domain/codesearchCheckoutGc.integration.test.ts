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
import { ensureRepositoryRevisionCheckout } from "../models/repositories.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  collectRepositoryCheckouts,
  listCollectableCheckouts,
  listLiveShas,
  releaseRunCheckout,
} from "./codesearchCheckoutGc.js"

const sha = () => randomBytes(20).toString("hex")
const orgId = generateObjectId("org")
const repositoryId = generateObjectId("repo")
const workspaceId = generateObjectId("ws")
const goneWorkspaceId = generateObjectId("ws")
const runIds = {
  parent: `run_${sha()}`,
  finished: `run_${sha()}`,
  pending: `run_${sha()}`,
  sleeping: `run_${sha()}`,
  outputs: `run_${sha()}`,
  other: `run_${sha()}`,
}
const codesearchUrl = "http://codesearch.test"

const published = sha()
const shas = {
  old: sha(),
  live: sha(),
  finished: sha(),
  pending: sha(),
  sleeping: sha(),
  stepOutput: sha(),
  oldStepOutput: sha(),
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
  finished: `rev:${shas.finished}`,
  pending: `rev:${shas.pending}`,
  sleeping: `rev:${shas.sleeping}`,
  stepOutput: `rev:${shas.stepOutput}`,
  oldStepOutput: `rev:${shas.oldStepOutput}`,
  raced: `rev:${sha()}`,
  wsLegacy: `ws:${workspaceId}`,
  wsCurrent: `ws:${workspaceId}:${shas.wsCurrent}`,
  wsOld: `ws:${workspaceId}:${shas.wsOld}`,
  wsGone: `ws:${goneWorkspaceId}:${shas.wsGone}`,
  fresh: `rev:${shas.fresh}`,
}
const deleteRequests: string[][] = []
const runEndedRequests: string[][] = []
const codesearch = setupServer(
  http.post(
    `${codesearchUrl}/${repositoryId}/checkouts/delete`,
    async ({ request }) => {
      const { checkoutKeys, runEnded } = (await request.json()) as {
        checkoutKeys: string[]
        runEnded?: boolean
      }
      if (runEnded) runEndedRequests.push(checkoutKeys)
      else deleteRequests.push(checkoutKeys)
      // A run takes the key again while codesearch deletes its files.
      if (checkoutKeys.includes(keys.raced))
        await ensureRepositoryRevisionCheckout({
          orgId,
          repositoryId,
          sha: keys.raced.slice("rev:".length),
        })
      return HttpResponse.json({
        deleted: checkoutKeys
          .filter((key) => key !== keys.wsGone)
          .map((checkoutKey) => ({ checkoutKey })),
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
    // Unfinished runs of the ingestion and index workflows: their SHAs are
    // still in use. A SHA in the input of a finished run, in an older output
    // of a step, or in a run of another workflow is not.
    const ns = openWorkflowNamespaceId()
    const now = new Date()
    const earlier = new Date(now.getTime() - 60_000)
    const run = (
      id: string,
      name: string,
      status: string,
      input: Record<string, unknown>,
    ) => sql`(${ns}, ${id}, ${name}, ${status}, '{}'::jsonb,
      ${JSON.stringify({ orgId, repositoryId, ...input })}::jsonb, 1,
      ${now.toISOString()}, ${now.toISOString()})`
    await getSystemDb().execute(sql`
      insert into openworkflow.workflow_runs
        (namespace_id, id, workflow_name, status, config, input, attempts, created_at, updated_at)
      values ${sql.join(
        [
          run(runIds.parent, "repository-ingestion", "running", {
            targetHash: shas.live,
          }),
          run(runIds.finished, "repository-index", "completed", {
            targetHash: shas.finished,
          }),
          run(runIds.pending, "repository-index", "pending", {
            targetHash: shas.pending,
          }),
          run(runIds.sleeping, "repository-ingestion-v2", "sleeping", {
            sha: shas.sleeping,
          }),
          run(runIds.outputs, "repository-ingestion", "running", {}),
          run(runIds.other, "conversation-sandbox-sweep", "running", {
            targetHash: shas.old,
          }),
        ],
        sql`, `,
      )}
    `)
    const attempt = (
      output: unknown,
      at: Date,
    ) => sql`(${ns}, ${`step_${sha()}`},
      ${runIds.outputs}, 'resolve-ref', 'function', 'completed', '{}'::jsonb,
      ${JSON.stringify(output)}::jsonb, ${at.toISOString()}, ${at.toISOString()})`
    await getSystemDb().execute(sql`
      insert into openworkflow.step_attempts
        (namespace_id, id, workflow_run_id, step_name, kind, status, config,
          output, created_at, updated_at)
      values
        ${attempt({ targetHash: shas.oldStepOutput }, earlier)},
        ${attempt({ targetHash: shas.stepOutput }, now)}
    `)
  })

  afterAll(async () => {
    codesearch.close()
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where id in (${sql.join(
        Object.values(runIds).map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("keeps the published, running, recent, and default checkouts, and collects every old Workspace key", async () => {
    const collectable = await listCollectableCheckouts({
      orgId,
      repositoryId,
      liveShas: await listLiveShas(),
    })

    expect(collectable.sort()).toEqual(
      [
        keys.old,
        keys.finished,
        keys.oldStepOutput,
        keys.raced,
        keys.wsLegacy,
        keys.wsCurrent,
        keys.wsOld,
        keys.wsGone,
      ].sort(),
    )
  })

  it("deletes the rows of the checkouts that codesearch deleted, but not of a key a run took again", async () => {
    const result = await collectRepositoryCheckouts({ orgId, repositoryId })

    expect(result).toEqual({ deletedKeys: 6 })
    expect(await storedKeys()).toEqual(
      [
        keys.default,
        keys.published,
        keys.live,
        keys.pending,
        keys.sleeping,
        keys.stepOutput,
        keys.wsGone,
        keys.fresh,
        keys.raced,
      ].sort(),
    )
  })

  it("does not ask codesearch again for the keys it kept in this pass", async () => {
    deleteRequests.length = 0

    await collectRepositoryCheckouts({ orgId, repositoryId })

    // Only the skipped `wsGone` is left, and it is asked for once.
    expect(deleteRequests).toEqual([[keys.wsGone]])
  })
  it("deletes the recent checkout of an ended run, but keeps the published key and a key another run reads", async () => {
    runEndedRequests.length = 0
    const ended = `run_${sha()}`

    expect(
      await releaseRunCheckout({ orgId, sha: published, runId: ended }),
    ).toEqual({ deletedKeys: 0 })
    expect(
      await releaseRunCheckout({ orgId, sha: shas.live, runId: ended }),
    ).toEqual({ deletedKeys: 0 })
    expect(runEndedRequests).toEqual([])

    // The running parent run reads `live`; when it ends, its key goes.
    expect(
      await releaseRunCheckout({ orgId, sha: shas.live, runId: runIds.parent }),
    ).toEqual({ deletedKeys: 1 })
    // `fresh` changed less than one hour ago; an ended run still deletes it.
    expect(
      await releaseRunCheckout({ orgId, sha: shas.fresh, runId: ended }),
    ).toEqual({ deletedKeys: 1 })
    expect(runEndedRequests).toEqual([[keys.live], [keys.fresh]])
    const stored = await storedKeys()
    expect(stored).toContain(keys.published)
    expect(stored).not.toContain(keys.live)
    expect(stored).not.toContain(keys.fresh)
  })

  it("stops after maxBatches calls when more keys are left", async () => {
    const old = new Date(Date.now() - 2 * 3_600_000)
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositoryCheckouts).values(
        Array.from({ length: 25 }, () => ({
          id: generateObjectId("co"),
          orgId,
          repositoryId,
          checkoutKey: `rev:${sha()}`,
          createdAt: old,
          updatedAt: old,
        })),
      ),
    )
    deleteRequests.length = 0

    const result = await collectRepositoryCheckouts({
      orgId,
      repositoryId,
      maxBatches: 2,
    })

    expect(deleteRequests.length).toBe(2)
    // `wsGone` may be in a batch: codesearch skips it.
    expect(result.deletedKeys).toBeGreaterThanOrEqual(19)
    expect(result.deletedKeys).toBeLessThanOrEqual(20)
    expect(
      await listCollectableCheckouts({
        orgId,
        repositoryId,
        liveShas: await listLiveShas(),
        exclude: [keys.wsGone],
      }),
    ).not.toHaveLength(0)
  })
})
