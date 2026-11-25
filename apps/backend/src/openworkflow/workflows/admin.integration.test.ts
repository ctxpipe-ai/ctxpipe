import { randomUUID } from "node:crypto"

import { eq, inArray, sql } from "drizzle-orm"
import { initLogger } from "evlog"
import { OpenWorkflow, type Worker } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { getSystemDb } from "../../db/client.js"
import { ownerUrlForMigrate } from "../../db/owner-migrate-url.js"
import { CONSOLE_ROLE_NAME } from "../../db/provision-console-role.js"
import {
  apikeys,
  members,
  organizations,
  sessions,
  users,
} from "../../db/schema/auth.js"
import { orgApiKeyCreators } from "../../db/schema/org_api_key_creators.js"
import { generateObjectId } from "../../lib/id.js"
import { getOrgFeature, setOrgFeature } from "../../models/org-features.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { connectOpenWorkflowBackend } from "../storable-backend.js"
import * as admin from "./admin.js"

/*
 * The operator console's path: it connects as `ctxpipe_console` and enqueues
 * an `admin.*` run by name with OpenWorkflow alone (no ctxpipe code), and the
 * worker runs it as the app role. The test connects as the owner and takes
 * the console role, so the row-level security of that role applies.
 */

const namespaceId = openWorkflowNamespaceId()
let seed: SeededOrg
let consoleSql: postgres.Sql
let consoleBackend: BackendPostgres
let consoleClient: OpenWorkflow
let workerBackend: BackendPostgres
let worker: Worker
/** A second user: an admin member of the seeded organization. */
let otherUserId = ""
let otherMemberId = ""
let ownerMemberId = ""

const request = (params: Record<string, unknown>) => ({
  requestId: randomUUID(),
  requestedBy: { kind: "operator", email: "operator@example.com" },
  approvedBy: "approver@example.com",
  params,
})

/** An enabled organization API key of the seeded organization. */
async function insertOrgKey(): Promise<string> {
  const keyId = generateObjectId("key")
  await getSystemDb().insert(apikeys).values({
    id: keyId,
    configId: "organization",
    referenceId: seed.orgId,
    key: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  return keyId
}

const keyEnabled = async (keyId: string) =>
  (
    await getSystemDb()
      .select({ enabled: apikeys.enabled })
      .from(apikeys)
      .where(eq(apikeys.id, keyId))
  )[0]?.enabled

/** Enqueue as the console does, and wait for the worker. */
async function runAsConsole(name: string, input: Record<string, unknown>) {
  const handle = await consoleClient.runWorkflow({ name }, input, {
    idempotencyKey: String(input.requestId),
  })
  return handle.result()
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  seed = await seedOrg()
  consoleSql = postgres(ownerUrlForMigrate(databaseUrl), {
    max: 2,
    onnotice: () => undefined,
    connection: { role: CONSOLE_ROLE_NAME },
  })
  consoleBackend = BackendPostgres.fromPool(consoleSql as never, {
    namespaceId,
  })
  consoleClient = new OpenWorkflow({ backend: consoleBackend })

  workerBackend = await connectOpenWorkflowBackend(databaseUrl, namespaceId)
  const runner = new OpenWorkflow({ backend: workerBackend })
  for (const workflow of Object.values(admin))
    runner.implementWorkflow(workflow.spec as never, workflow.fn as never)
  worker = runner.newWorker({ concurrency: 2 })
  await worker.start()

  const db = getSystemDb()
  otherUserId = generateObjectId("user")
  await db.insert(users).values({
    id: otherUserId,
    name: "Other member",
    email: `other-${randomUUID()}@example.com`,
  })
  otherMemberId = generateObjectId("mbr")
  await db.insert(members).values({
    id: otherMemberId,
    organizationId: seed.orgId,
    userId: otherUserId,
    role: "admin",
    createdAt: new Date(),
  })
  const [owner] = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.userId, seed.userId))
  if (!owner) throw new Error("the seeded user is not a member")
  ownerMemberId = owner.id
})

afterAll(async () => {
  await worker?.stop()
  await workerBackend?.stop()
  await consoleSql?.end()
  await getSystemDb().delete(users).where(eq(users.id, otherUserId))
  if (seed) await cleanupSeededOrg(seed)
})

describe("the console role on workflow_runs", () => {
  it("enqueues an admin run by name once per request id", async () => {
    const input = request({ userId: otherUserId })
    const first = await consoleClient.runWorkflow(
      { name: "admin.revoke-sessions" },
      input,
      { idempotencyKey: input.requestId },
    )
    const again = await consoleClient.runWorkflow(
      { name: "admin.revoke-sessions" },
      input,
      { idempotencyKey: input.requestId },
    )
    expect(again.workflowRun.id).toBe(first.workflowRun.id)
    expect(await first.result()).toEqual({
      ok: true,
      userId: otherUserId,
      revokedSessions: 0,
    })
  })

  it("may not insert another run, nor see, change or delete one", async () => {
    await expect(
      consoleClient.runWorkflow({ name: "repository-deletion" }, {}),
    ).rejects.toThrow(/row-level security/)

    const app = new OpenWorkflow({ backend: workerBackend })
    const other = await app.runWorkflow(
      { name: `console-test-other-${randomUUID()}` },
      {},
    )
    try {
      const visible = await consoleSql<{ id: string }[]>`
        select id from openworkflow.workflow_runs where namespace_id = ${namespaceId}`
      expect(visible.map((row) => row.id)).not.toContain(other.workflowRun.id)
      expect(
        await consoleBackend.getWorkflowRun({
          workflowRunId: other.workflowRun.id,
        }),
      ).toBeNull()
    } finally {
      await app.cancelWorkflowRun(other.workflowRun.id)
    }

    for (const statement of [
      consoleSql`update openworkflow.workflow_runs set status = 'canceled'`,
      consoleSql`delete from openworkflow.workflow_runs`,
      consoleSql`select 1 from openworkflow.step_attempts limit 1`,
      consoleSql`select 1 from openworkflow.workflow_signals limit 1`,
    ])
      await expect(statement).rejects.toThrow(/permission denied/)
  })

  it("may insert only a new pending run", async () => {
    await expect(consoleSql`
      insert into openworkflow.workflow_runs
        (namespace_id, id, workflow_name, status, config, context, input, attempts, available_at, created_at, updated_at)
      values (${namespaceId}, ${randomUUID()}, 'admin.ban-user', 'completed', '{}', '{}', '{}', 0, now(), now(), now())`).rejects.toThrow(
      /row-level security/,
    )
  })

  it("reads the auth tables only through the views, which hold no secret", async () => {
    const columns = await consoleSql<
      { table_name: string; column_name: string }[]
    >`
      select table_name, column_name from information_schema.columns
      where table_schema = 'console_read' order by table_name, ordinal_position`
    const byView: Record<string, string[]> = {}
    for (const { table_name, column_name } of columns)
      (byView[table_name] ??= []).push(column_name)
    expect(byView).toEqual({
      invitations: [
        "id",
        "organization_id",
        "email",
        "role",
        "status",
        "expires_at",
        "inviter_id",
        "created_at",
      ],
      members: ["id", "organization_id", "user_id", "role", "created_at"],
      organizations: ["id", "name", "slug", "created_at"],
      sessions: [
        "id",
        "user_id",
        "active_organization_id",
        "ip_address",
        "user_agent",
        "created_at",
        "expires_at",
      ],
      users: [
        "id",
        "name",
        "email",
        "email_verified",
        "banned",
        "ban_reason",
        "ban_expires",
        "created_at",
      ],
    })
    expect(
      columns.filter(({ column_name }) =>
        /token|secret|password|hash|key|code/.test(column_name),
      ),
    ).toEqual([])
    const [user] = await consoleSql<{ id: string }[]>`
      select id from console_read.users where id = ${seed.userId}`
    expect(user?.id).toBe(seed.userId)
    for (const statement of [
      consoleSql`select 1 from public.sessions limit 1`,
      consoleSql`select 1 from public.users limit 1`,
      consoleSql`select 1 from public.apikeys limit 1`,
      consoleSql`select 1 from public.accounts limit 1`,
    ])
      await expect(statement).rejects.toThrow(/permission denied/)
  })

  it("owns the schema console, which the app role cannot use", async () => {
    const [owner] = await consoleSql<{ owner: string }[]>`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'console'`
    expect(owner?.owner).toBe(CONSOLE_ROLE_NAME)
    // The rights of the session user: the app role.
    const { rows } = await getSystemDb().execute<{
      console: boolean
      read: boolean
    }>(
      sql`select has_schema_privilege('console', 'USAGE') as console,
              has_schema_privilege('console_read', 'USAGE') as read`,
    )
    expect(rows).toEqual([{ console: false, read: false }])
  })
})

describe("the admin jobs", () => {
  it("refuses a run without requestId, requestedBy or approvedBy", async () => {
    for (const missing of ["requestId", "requestedBy", "approvedBy"]) {
      const input: Record<string, unknown> = request({ userId: otherUserId })
      delete input[missing]
      const handle = await consoleClient.runWorkflow(
        { name: "admin.revoke-sessions" },
        input,
      )
      await expect(handle.result(), missing).rejects.toThrow()
    }
  })

  it("bans and unbans a user", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000)
    // An organization key with no known maker, in an organization of the user.
    const legacyKey = await insertOrgKey()
    expect(
      await runAsConsole(
        "admin.ban-user",
        request({
          userId: otherUserId,
          reason: "Abuse",
          expiresAt: until.toISOString(),
          disableUnattributedOrgApiKeys: true,
        }),
      ),
    ).toEqual({
      ok: true,
      userId: otherUserId,
      disabledUnattributedOrgApiKeys: 1,
    })
    expect(await keyEnabled(legacyKey)).toBe(false)
    const banState = () =>
      getSystemDb()
        .select({
          banned: users.banned,
          banReason: users.banReason,
          banExpires: users.banExpires,
        })
        .from(users)
        .where(eq(users.id, otherUserId))
    expect(await banState()).toEqual([
      { banned: true, banReason: "Abuse", banExpires: until },
    ])

    await runAsConsole("admin.unban-user", request({ userId: otherUserId }))
    expect(await banState()).toEqual([
      { banned: false, banReason: null, banExpires: null },
    ])
  })

  it("revokes the sessions of a user", async () => {
    await getSystemDb()
      .insert(sessions)
      .values({
        id: generateObjectId("sess"),
        token: randomUUID(),
        userId: otherUserId,
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      })
    expect(
      await runAsConsole(
        "admin.revoke-sessions",
        request({ userId: otherUserId }),
      ),
    ).toEqual({ ok: true, userId: otherUserId, revokedSessions: 1 })
  })

  it("keeps the last owner: no demotion and no removal", async () => {
    const params = { organizationId: seed.orgId, memberId: ownerMemberId }
    await expect(
      runAsConsole(
        "admin.set-member-role",
        request({ ...params, role: "admin" }),
      ),
    ).rejects.toThrow(/only owner/)
    await expect(
      runAsConsole("admin.remove-member", request(params)),
    ).rejects.toThrow(/only owner/)
    await expect(
      runAsConsole(
        "admin.remove-member",
        request({ organizationId: seed.orgId, memberId: "mbr_unknown" }),
      ),
    ).rejects.toThrow(/is not in organization/)
  })

  it("changes the role of a member, then removes the member", async () => {
    const params = { organizationId: seed.orgId, memberId: otherMemberId }
    expect(
      await runAsConsole(
        "admin.set-member-role",
        request({ ...params, role: "owner" }),
      ),
    ).toEqual({ ok: true, ...params, role: "owner", previousRole: "admin" })
    // With two owners, the first one may go down to admin.
    await runAsConsole(
      "admin.set-member-role",
      request({
        organizationId: seed.orgId,
        memberId: ownerMemberId,
        role: "admin",
      }),
    )
    await runAsConsole(
      "admin.set-member-role",
      request({
        organizationId: seed.orgId,
        memberId: ownerMemberId,
        role: "owner",
      }),
    )
    // A key that the member made, and one with no known maker: the
    // removal disables both.
    const keyId = await insertOrgKey()
    await getSystemDb()
      .insert(orgApiKeyCreators)
      .values({ apiKeyId: keyId, userId: otherUserId })
    const legacyKey = await insertOrgKey()
    expect(
      await runAsConsole(
        "admin.remove-member",
        request({ ...params, disableUnattributedOrgApiKeys: true }),
      ),
    ).toEqual({
      ok: true,
      ...params,
      userId: otherUserId,
      disabledOrgApiKeys: 1,
      disabledUnattributedOrgApiKeys: 1,
    })
    expect(await keyEnabled(keyId)).toBe(false)
    expect(await keyEnabled(legacyKey)).toBe(false)
    expect(
      await getSystemDb()
        .select({ id: members.id })
        .from(members)
        .where(eq(members.id, otherMemberId)),
    ).toEqual([])
  })

  it("refuses to delete an organization that does not exist", async () => {
    await expect(
      runAsConsole(
        "admin.delete-organization",
        request({ organizationId: "org_unknown" }),
      ),
    ).rejects.toThrow(/not found/)
  })

  it("deletes an organization with its members", async () => {
    const db = getSystemDb()
    const organizationId = generateObjectId("org")
    await db.insert(organizations).values({
      id: organizationId,
      name: "Doomed",
      slug: `doomed-${organizationId.slice(-8).toLowerCase()}`,
      createdAt: new Date(),
    })
    await db.insert(members).values({
      id: generateObjectId("mbr"),
      organizationId,
      userId: seed.userId,
      role: "owner",
      createdAt: new Date(),
    })
    expect(
      await runAsConsole(
        "admin.delete-organization",
        request({ organizationId }),
      ),
    ).toEqual({ ok: true, organizationId })
    expect(
      await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    ).toEqual([])
    expect(
      await db
        .select({ id: members.id })
        .from(members)
        .where(inArray(members.organizationId, [organizationId])),
    ).toEqual([])
  })
})

describe("the fast path to off (admin.set-org-feature)", () => {
  it("sets the flag at once, logs the audit record, and holds the value against the config", async () => {
    const events: Record<string, unknown>[] = []
    // setup-evlog turns evlog off; this test reads the drained events.
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })
    try {
      await setOrgFeature(seed.orgId, "knowledge_plane", "shadow", {
        source: "config",
      })
      const input = request({
        organizationId: seed.orgId,
        feature: "knowledge_plane",
        value: "off",
      })
      expect(await runAsConsole("admin.set-org-feature", input)).toEqual({
        ok: true,
        organizationId: seed.orgId,
        feature: "knowledge_plane",
        previous: "shadow",
        value: "off",
        changed: true,
      })
      expect(await getOrgFeature(seed.orgId, "knowledge_plane")).toBe("off")
      expect(
        events.filter(
          (event) =>
            event.step === "org_features.set" &&
            event.orgId === seed.orgId &&
            event.source === "operator",
        ),
      ).toEqual([
        expect.objectContaining({
          feature: "knowledge_plane",
          previous: "shadow",
          value: "off",
          changed: true,
          requestId: input.requestId,
          requestedBy: input.requestedBy,
          approvedBy: input.approvedBy,
        }),
      ])

      // The next hosted update runs the config with its old value.
      await setOrgFeature(seed.orgId, "knowledge_plane", "shadow", {
        source: "config",
      })
      expect(await getOrgFeature(seed.orgId, "knowledge_plane")).toBe("off")
    } finally {
      initLogger({ enabled: false })
    }
  })

  it("refuses an unknown organization, feature or value", async () => {
    await expect(
      runAsConsole(
        "admin.set-org-feature",
        request({
          organizationId: "org_unknown",
          feature: "knowledge_plane",
          value: "off",
        }),
      ),
    ).rejects.toThrow(/not found/)
    for (const params of [
      { feature: "no_such_feature", value: "off" },
      { feature: "knowledge_plane", value: "maybe" },
    ])
      await expect(
        runAsConsole(
          "admin.set-org-feature",
          request({ organizationId: seed.orgId, ...params }),
        ),
      ).rejects.toThrow()
  })
})
