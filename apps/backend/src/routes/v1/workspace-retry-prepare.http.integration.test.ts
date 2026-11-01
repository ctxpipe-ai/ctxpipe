import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const execFileAsync = promisify(execFile)
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_retry_prepare_${suffix}`,
  slug: `retry-prepare-${suffix}`,
  name: "Retry prepare",
}
const app = () => workspaceHttpApp(org, workspaceRoutes)
const sha = "c".repeat(40)
let repositoryDir: string | undefined

async function seedWorkspace(
  name: string,
  state: {
    hydrateStatus: "ready" | "pending" | "failed"
    hydrateError?: string
    desiredSha: string | null
    active?: true
    url?: string
  },
) {
  const id = `ws_${name}_${suffix}`
  const url = state.url ?? `https://github.com/example/${name}-${suffix}.git`
  const revision: WorkspaceRevision = {
    workspaceId: id,
    generation: 1,
    remote: { url, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read",
  }
  await withOrgDbContext(org.id, (db) =>
    db.insert(workspaces).values({
      id,
      orgId: org.id,
      slug: name,
      displayName: name,
      workspaceRepositoryUrl: url,
      formatVersion: 3,
      desiredSha: state.desiredSha,
      desiredDefaultBranch: state.desiredSha ? "main" : null,
      hydrateStatus: state.hydrateStatus,
      hydrateError: state.hydrateError ?? null,
      ...(state.active
        ? {
            activeRevision: revision,
            activeProjectionUrl: url,
            activeProjectionSha: sha,
            indexedSha: sha,
          }
        : {}),
    }),
  )
  return id
}

async function hydrateRunCount(workspaceId: string) {
  const result = await getSystemDb().execute<{ count: number }>(sql`
    select count(*)::int as count from openworkflow.workflow_runs
    where workflow_name = 'workspace-hydrate'
      and input->>'workspaceId' = ${workspaceId}
  `)
  return result.rows[0]?.count ?? 0
}

async function hydrateState(workspaceId: string) {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select({
        hydrateStatus: workspaces.hydrateStatus,
        hydrateError: workspaces.hydrateError,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  )
  return row
}

function retry(slug: string) {
  return app().request(`/workspaces/${slug}/retry-prepare`, { method: "POST" })
}

describe("Retry of a Workspace prepare (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'workspaceId' like ${`%_${suffix}`}`,
    )
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
    if (repositoryDir) await rm(repositoryDir, { recursive: true, force: true })
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
    await closeDb()
  })

  // A retry of a ready Workspace sets it back to pending. The hydrate then
  // finds the active revision and does not set it to ready again.
  it("refuses a ready Workspace and queues no run", async () => {
    const id = await seedWorkspace("ready", {
      hydrateStatus: "ready",
      desiredSha: sha,
      active: true,
    })

    const response = await retry("ready")

    expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty("error")
    expect(await hydrateState(id)).toEqual({
      hydrateStatus: "ready",
      hydrateError: null,
    })
    expect(await hydrateRunCount(id)).toBe(0)
  })

  it("refuses a prepare in progress and queues no run", async () => {
    const id = await seedWorkspace("building", {
      hydrateStatus: "pending",
      desiredSha: sha,
    })

    const response = await retry("building")

    expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty("error")
    expect(await hydrateState(id)).toEqual({
      hydrateStatus: "pending",
      hydrateError: null,
    })
    expect(await hydrateRunCount(id)).toBe(0)
  })

  it("queues one run for a failed prepare and clears the error", async () => {
    const id = await seedWorkspace("failed", {
      hydrateStatus: "failed",
      hydrateError: "clone failed",
      desiredSha: sha,
    })

    const response = await retry("failed")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      hydrateStatus: "pending",
      hydrateError: null,
    })
    await expect.poll(() => hydrateRunCount(id), { timeout: 5_000 }).toBe(1)
  })

  it("queues one run for two retries of a failed prepare", async () => {
    const id = await seedWorkspace("twice", {
      hydrateStatus: "failed",
      hydrateError: "clone failed",
      desiredSha: sha,
    })

    const [first, second] = await Promise.all([retry("twice"), retry("twice")])

    // The first retry moves the Workspace to pending, so the second finds
    // no failed prepare.
    expect([first.status, second.status].sort()).toEqual([200, 409])
    await expect.poll(() => hydrateRunCount(id), { timeout: 5_000 }).toBe(1)
    expect(await hydrateRunCount(id)).toBe(1)
  })

  it("starts at most one run of a tip in each UTC minute", async () => {
    // Both requests fall in the same UTC minute. Only `Date` is fake: the
    // database client needs real timers.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 1_000)
    const id = await seedWorkspace("minute", {
      hydrateStatus: "failed",
      hydrateError: "clone failed",
      desiredSha: sha,
    })
    expect((await retry("minute")).status).toBe(200)
    await expect.poll(() => hydrateRunCount(id), { timeout: 5_000 }).toBe(1)
    // The run of the first request fails again before the second request.
    await getSystemDb().execute(
      sql`update openworkflow.workflow_runs set status = 'completed'
          where input->>'workspaceId' = ${id}`,
    )
    await withOrgDbContext(org.id, (db) =>
      db
        .update(workspaces)
        .set({ hydrateStatus: "failed", hydrateError: "clone failed" })
        .where(eq(workspaces.id, id)),
    )

    expect((await retry("minute")).status).toBe(200)

    // The queue is not awaited. Give it time to write a second run.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await hydrateRunCount(id)).toBe(1)
  })

  it("queues one run for a Workspace that waits for its tip", async () => {
    repositoryDir = await mkdtemp(join(tmpdir(), "ctxpipe-retry-prepare-"))
    const git = (...args: string[]) =>
      execFileAsync("git", ["-C", repositoryDir as string, ...args])
    await git("init", "-b", "main")
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "First",
    )
    const id = await seedWorkspace("tip", {
      hydrateStatus: "pending",
      desiredSha: null,
      url: repositoryDir,
    })

    const response = await retry("tip")

    expect(response.status).toBe(200)
    await expect.poll(() => hydrateRunCount(id), { timeout: 5_000 }).toBe(1)
  })
})
