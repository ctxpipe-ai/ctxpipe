import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import type { Env } from "../config/env.js"
import { backfillMissingPagerdutyConnectionDirectory } from "../db/backfill-pagerduty-connection-directory.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connectionDirectory,
  connections,
} from "../db/schema/connections.js"
import {
  encodePagerdutyOAuthClientSecretForDb,
  encodePagerdutyTokensForDb,
  encodePagerdutyWebhookSecretForDb,
  type PagerdutySetupPhase,
  serialisePagerdutyConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import { getConnectionDirectoryByConnectionId } from "./connection-directory.js"
import {
  claimPagerdutyBindingInitialSync,
  clearPagerdutySyncBindingsForRepository,
  createOrReusePagerdutyDraft,
  deletePagerdutyConnectionById,
  finalizePagerdutyBindingAfterContentWorkflow,
  getPagerdutyBindingByConnectionId,
  getPagerdutyConnectionByConnectionId,
  listPagerdutyConnectionsByWebhookSubscriptionId,
  listPagerdutyConnectionsForOrg,
  persistPagerdutyWebhookSubscriptionIfAbsent,
  recordPagerdutyOAuthRevocation,
  refreshPagerdutyConnectionTokensWithLock,
  savePagerdutyOAuthApp,
  upsertPagerdutyConnectionFromOAuth,
} from "./pagerduty-connector.js"

const execFileAsync = promisify(execFile)
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const backendRoot = resolve(__dirname, "../..")
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_pd_directory_${suffix}`
const otherOrgId = `org_test_pd_directory_other_${suffix}`
const connectionId = generateObjectId("con")
const otherConnectionId = generateObjectId("con")
const webhookSubscriptionId = `PFSUB_${suffix}`
const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
} as Env

function historicalPagerdutyConfig() {
  return {
    accountId: "PDACCT",
    accountName: "Acme PD",
    accountSubdomain: "acme",
    region: "us" as const,
    ownerUserId: "user_pd_hist",
    status: "installed",
    webhookSubscriptionId,
    setupPhase: "live",
    enabled: true,
  }
}

describeWithDatabase("PagerDuty webhook directory backfill (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) return
    initDb(connectionString)
    await getSystemDb()
      .insert(organizations)
      .values([
        {
          id: orgId,
          name: "PagerDuty directory backfill",
          slug: `pd-directory-${suffix}`,
          createdAt: new Date(),
        },
        {
          id: otherOrgId,
          name: "PagerDuty directory other org",
          slug: `pd-directory-other-${suffix}`,
          createdAt: new Date(),
        },
      ])
    await withOrgDbContext(orgId, (db) =>
      db.insert(connections).values({
        id: connectionId,
        orgId,
        type: CONNECTION_TYPE_PAGERDUTY,
        config: historicalPagerdutyConfig(),
      }),
    )
    await withOrgDbContext(otherOrgId, (db) =>
      db.insert(connections).values({
        id: otherConnectionId,
        orgId: otherOrgId,
        type: CONNECTION_TYPE_PAGERDUTY,
        config: {
          ...historicalPagerdutyConfig(),
          accountId: "PDOTHER",
          webhookSubscriptionId: `PFSUB_OTHER_${suffix}`,
        },
      }),
    )
  })

  afterAll(async () => {
    if (!connectionString) return
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, orgId))
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, otherOrgId))
    await withOrgDbContext(orgId, (db) =>
      db.delete(connections).where(eq(connections.id, connectionId)),
    )
    await withOrgDbContext(otherOrgId, (db) =>
      db.delete(connections).where(eq(connections.id, otherConnectionId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, otherOrgId))
    await closeDb()
  })

  it("repairs historical PagerDuty rows so webhook lookup finds them without a tenant scan", async () => {
    await expect(
      getConnectionDirectoryByConnectionId(connectionId),
    ).resolves.toBeUndefined()
    await expect(
      listPagerdutyConnectionsByWebhookSubscriptionId({
        webhookSubscriptionId,
        env,
      }),
    ).resolves.toEqual([])

    const inserted = await backfillMissingPagerdutyConnectionDirectory({
      orgId,
    })
    expect(inserted).toBe(1)

    await expect(
      getConnectionDirectoryByConnectionId(connectionId),
    ).resolves.toMatchObject({
      connectionId,
      orgId,
      type: CONNECTION_TYPE_PAGERDUTY,
    })
    await expect(
      getConnectionDirectoryByConnectionId(otherConnectionId),
    ).resolves.toBeUndefined()

    const found = await listPagerdutyConnectionsByWebhookSubscriptionId({
      webhookSubscriptionId,
      env,
    })
    expect(found.map((row) => row.id)).toEqual([connectionId])

    await expect(
      backfillMissingPagerdutyConnectionDirectory({ orgId }),
    ).resolves.toBe(0)

    await execFileAsync(
      "pnpm",
      ["exec", "tsx", "src/db/backfill-pagerduty-connection-directory-cli.ts"],
      {
        cwd: backendRoot,
        env: { ...process.env, DATABASE_URL: connectionString },
      },
    )
    await expect(
      getConnectionDirectoryByConnectionId(otherConnectionId),
    ).resolves.toMatchObject({
      connectionId: otherConnectionId,
      orgId: otherOrgId,
      type: CONNECTION_TYPE_PAGERDUTY,
    })
  })
})

const lifecycleSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const lifecycleOrgId = `org_test_pd_lifecycle_${lifecycleSuffix}`

function pagerdutyLifecycleConfig(
  setupPhase: PagerdutySetupPhase,
  status: "pending" | "installed" | "revoked" = "installed",
) {
  return {
    accountId: "PDLIFE",
    accountName: "Lifecycle PD",
    accountSubdomain: "lifecycle",
    region: "us" as const,
    ownerUserId: "user_pd_life",
    status,
    webhookSubscriptionId: `PFSUB_LIFE_${lifecycleSuffix}`,
    setupPhase,
    enabled: true,
    repositoryId: "repo_1",
    branch: "main",
  }
}

describeWithDatabase("PagerDuty connector lifecycle (Postgres)", () => {
  const connectionId = generateObjectId("con")

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is unset")
    initDb(connectionString)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: lifecycleOrgId,
        name: "PagerDuty lifecycle",
        slug: `pd-lifecycle-${lifecycleSuffix}`,
        createdAt: new Date(),
      })
  })

  afterAll(async () => {
    if (!connectionString) return
    await withOrgDbContext(lifecycleOrgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, lifecycleOrgId)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, lifecycleOrgId))
    await closeDb()
  })

  async function replaceConnection(
    setupPhase: PagerdutySetupPhase,
    status: "pending" | "installed" | "revoked" = "installed",
  ) {
    await withOrgDbContext(lifecycleOrgId, async (db) => {
      await db.delete(connections).where(eq(connections.id, connectionId))
      await db.insert(connections).values({
        id: connectionId,
        orgId: lifecycleOrgId,
        type: CONNECTION_TYPE_PAGERDUTY,
        config: pagerdutyLifecycleConfig(setupPhase, status),
      })
    })
  }

  it.each([
    "awaiting_merge",
    "sync_failed",
    "live",
  ] as const)("claims initial sync from %s", async (setupPhase) => {
    await replaceConnection(setupPhase)
    await expect(
      claimPagerdutyBindingInitialSync({
        orgId: lifecycleOrgId,
        connectionId,
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(true)
  })

  it.each([
    "draft",
    "config_failed",
    "initial_sync",
  ] as const)("does not claim initial sync from %s", async (setupPhase) => {
    await replaceConnection(setupPhase)
    await expect(
      claimPagerdutyBindingInitialSync({
        orgId: lifecycleOrgId,
        connectionId,
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("does not claim initial sync for a revoked connection", async () => {
    await replaceConnection("live", "revoked")
    await expect(
      claimPagerdutyBindingInitialSync({
        orgId: lifecycleOrgId,
        connectionId,
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("finalizes completed content sync as live", async () => {
    await replaceConnection("initial_sync")
    await expect(
      finalizePagerdutyBindingAfterContentWorkflow({
        orgId: lifecycleOrgId,
        connectionId,
        workflowStatus: "completed",
      }),
    ).resolves.toBe(true)
    const [live] = await withOrgDbContext(lifecycleOrgId, (db) =>
      db
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .limit(1),
    )
    expect(live?.config).toMatchObject({ setupPhase: "live" })
  })

  it("finalizes a revoked in-flight sync as failed", async () => {
    await replaceConnection("initial_sync", "revoked")
    await expect(
      finalizePagerdutyBindingAfterContentWorkflow({
        orgId: lifecycleOrgId,
        connectionId,
        workflowStatus: "completed",
      }),
    ).resolves.toBe(true)
    const [failed] = await withOrgDbContext(lifecycleOrgId, (db) =>
      db
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .limit(1),
    )
    expect(failed?.config).toMatchObject({ setupPhase: "sync_failed" })
  })
})

const storageSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const storageOrgId = `org_test_pd_storage_${storageSuffix}`
const storageEnv = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
  PAGERDUTY_CLIENT_ID: "hosted-client",
  PAGERDUTY_CLIENT_SECRET: "hosted-secret",
} as unknown as Env

describeWithDatabase("PagerDuty connection storage (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is unset")
    initDb(connectionString)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: storageOrgId,
        name: "PagerDuty storage",
        slug: `pd-storage-${storageSuffix}`,
        createdAt: new Date(),
      })
  })

  afterEach(async () => {
    if (!connectionString) return
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, storageOrgId))
    await withOrgDbContext(storageOrgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, storageOrgId)),
    )
  })

  afterAll(async () => {
    if (!connectionString) return
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, storageOrgId))
    await withOrgDbContext(storageOrgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, storageOrgId)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, storageOrgId))
    await closeDb()
  })

  function storedConfig(input: {
    accountId: string
    accountName?: string
    accountSubdomain?: string
    status?: string
    setupPhase?: PagerdutySetupPhase
    repositoryId?: string | null
    branch?: string | null
    enabled?: boolean
    accessToken?: string
    refreshToken?: string | null
    webhookSubscriptionId?: string
    webhookSecret?: string
    oauthClientId?: string
    oauthClientSecret?: string
  }) {
    return serialisePagerdutyConnectionConfigForDb({
      accountId: input.accountId,
      accountName: input.accountName ?? "Acme PD",
      accountSubdomain: input.accountSubdomain ?? "acme",
      region: "us",
      ownerUserId: "user_pd_store",
      status: input.status ?? "pending",
      setupPhase: input.setupPhase ?? "draft",
      enabled: input.enabled ?? true,
      repositoryId: input.repositoryId,
      branch: input.branch,
      ...(input.accessToken
        ? encodePagerdutyTokensForDb(
            {
              accessToken: input.accessToken,
              refreshToken: input.refreshToken ?? null,
            },
            storageEnv,
          )
        : {}),
      webhookSubscriptionId: input.webhookSubscriptionId,
      webhookSecretEnc: input.webhookSecret
        ? encodePagerdutyWebhookSecretForDb(input.webhookSecret, storageEnv)
        : undefined,
      oauthClientId: input.oauthClientId,
      oauthClientSecretEnc: input.oauthClientSecret
        ? encodePagerdutyOAuthClientSecretForDb(
            input.oauthClientSecret,
            storageEnv,
          )
        : undefined,
    })
  }

  async function insertConnection(
    id: string,
    config: ReturnType<typeof storedConfig>,
  ) {
    await withOrgDbContext(storageOrgId, (db) =>
      db.insert(connections).values({
        id,
        orgId: storageOrgId,
        type: CONNECTION_TYPE_PAGERDUTY,
        config,
      }),
    )
  }

  async function readConnection(id: string) {
    return withOrgDbContext(storageOrgId, () =>
      getPagerdutyConnectionByConnectionId(storageOrgId, id, storageEnv),
    )
  }

  function oauthInput(
    overrides: Partial<
      Parameters<typeof upsertPagerdutyConnectionFromOAuth>[0]
    > & {
      accountId: string
    },
  ) {
    return {
      orgId: storageOrgId,
      env: storageEnv,
      ownerUserId: "user_pd_store",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us" as const,
      actorUserId: "user_pd",
      oauthApp: {
        clientId: "hosted-client",
        clientSecret: "hosted-secret",
      },
      ...overrides,
    }
  }

  it("locks OAuth upserts so the same account stays a single connection", async () => {
    const accountId = `acct_lock_${storageSuffix}`
    const [first, second] = await Promise.all([
      withOrgDbContext(storageOrgId, () =>
        upsertPagerdutyConnectionFromOAuth(
          oauthInput({
            accountId,
            accessToken: "tok_a",
            refreshToken: "ref_a",
          }),
        ),
      ),
      withOrgDbContext(storageOrgId, () =>
        upsertPagerdutyConnectionFromOAuth(
          oauthInput({
            accountId,
            accessToken: "tok_b",
            refreshToken: "ref_b",
          }),
        ),
      ),
    ])
    expect(first.id).toBe(second.id)
    const listed = await withOrgDbContext(storageOrgId, () =>
      listPagerdutyConnectionsForOrg(storageOrgId, storageEnv),
    )
    expect(listed.filter((row) => row.accountId === accountId)).toHaveLength(1)
    const stored = await readConnection(first.id)
    expect([first.accessToken, second.accessToken]).toContain(
      stored?.accessToken,
    )
    expect(["tok_a", "tok_b"]).toContain(stored?.accessToken)
  })

  it("preserves the latest binding when re-authorising a revoked account", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "revoked",
        setupPhase: "live",
        enabled: false,
        repositoryId: "repo_rebound",
        branch: "release",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        webhookSubscriptionId: `PFKEEP_${storageSuffix}`,
        webhookSecret: "keep-webhook",
        oauthClientId: "old-row-client",
        oauthClientSecret: "old-row-secret",
      }),
    )

    const result = await withOrgDbContext(storageOrgId, () =>
      upsertPagerdutyConnectionFromOAuth(oauthInput({ accountId: "acme" })),
    )

    expect(result).toMatchObject({
      id: connectionId,
      accessToken: "new_access",
      refreshToken: "new_refresh",
      repositoryId: "repo_rebound",
      branch: "release",
      enabled: true,
      webhookSubscriptionId: `PFKEEP_${storageSuffix}`,
      oauthClientId: null,
    })
    const stored = await readConnection(connectionId)
    expect(stored).toMatchObject({
      accessToken: "new_access",
      repositoryId: "repo_rebound",
      branch: "release",
      enabled: true,
      oauthClientId: null,
      oauthClientSecretEnc: null,
    })
  })

  it("merges a self-host draft into the existing account connection", async () => {
    const draftId = generateObjectId("con")
    const existingId = generateObjectId("con")
    await insertConnection(
      draftId,
      storedConfig({
        accountId: `pending:${draftId}`,
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        status: "pending",
        setupPhase: "draft",
        oauthClientId: "row-client",
        oauthClientSecret: "row-secret",
      }),
    )
    await insertConnection(
      existingId,
      storedConfig({
        accountId: "acme",
        status: "installed",
        setupPhase: "live",
        repositoryId: "repo_1",
        branch: "main",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        webhookSubscriptionId: `PFSUB_EXIST_${storageSuffix}`,
        webhookSecret: "stored-webhook-secret",
      }),
    )

    const result = await withOrgDbContext(storageOrgId, () =>
      upsertPagerdutyConnectionFromOAuth(
        oauthInput({
          accountId: "acme",
          oauthApp: { clientId: "row-client", clientSecret: "row-secret" },
          connectionId: draftId,
        }),
      ),
    )

    expect(result).toMatchObject({
      id: existingId,
      status: "installed",
      repositoryId: "repo_1",
      webhookSubscriptionId: `PFSUB_EXIST_${storageSuffix}`,
      oauthClientId: "row-client",
      accessToken: "new_access",
    })
    await expect(readConnection(draftId)).resolves.toBeUndefined()
    const stored = await readConnection(existingId)
    expect(stored?.oauthClientId).toBe("row-client")
    expect(stored?.oauthClientSecretEnc).toEqual(
      expect.stringMatching(/^ctxv1:/),
    )
  })

  it("keeps a new connection pending until its webhook secret is stored", async () => {
    const draftId = generateObjectId("con")
    await insertConnection(
      draftId,
      storedConfig({
        accountId: `pending:${draftId}`,
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        status: "pending",
        setupPhase: "draft",
      }),
    )

    const result = await withOrgDbContext(storageOrgId, () =>
      upsertPagerdutyConnectionFromOAuth(
        oauthInput({ accountId: "acme-new", connectionId: draftId }),
      ),
    )

    expect(result).toMatchObject({
      id: draftId,
      status: "pending",
      accountId: "acme-new",
      accessToken: "new_access",
      webhookSubscriptionId: null,
    })
  })

  it("rejects a second authorised account on the same connection", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "first-account",
        accountName: "First account",
        accountSubdomain: "first",
        status: "pending",
        setupPhase: "draft",
        accessToken: "first-access",
        refreshToken: "first-refresh",
      }),
    )

    await expect(
      withOrgDbContext(storageOrgId, () =>
        upsertPagerdutyConnectionFromOAuth(
          oauthInput({
            accountId: "second-account",
            accountName: "Second account",
            accountSubdomain: "second",
            connectionId,
          }),
        ),
      ),
    ).rejects.toThrow(
      "PagerDuty authorised account does not match this connection",
    )
    const stored = await readConnection(connectionId)
    expect(stored).toMatchObject({
      accountId: "first-account",
      accessToken: "first-access",
    })
  })

  it("rejects tokens when the row OAuth app changed during authorisation", async () => {
    const draftId = generateObjectId("con")
    await insertConnection(
      draftId,
      storedConfig({
        accountId: `pending:${draftId}`,
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        status: "pending",
        setupPhase: "draft",
        oauthClientId: "replacement-client",
        oauthClientSecret: "replacement-secret",
      }),
    )

    await expect(
      withOrgDbContext(storageOrgId, () =>
        upsertPagerdutyConnectionFromOAuth(
          oauthInput({
            accountId: "acme",
            oauthApp: { clientId: "old-client", clientSecret: "old-secret" },
            connectionId: draftId,
          }),
        ),
      ),
    ).rejects.toThrow(
      "PagerDuty OAuth app changed during authorisation. Try again.",
    )
    const stored = await readConnection(draftId)
    expect(stored).toMatchObject({
      accountId: `pending:${draftId}`,
      accessToken: null,
      oauthClientId: "replacement-client",
    })
  })

  it("retains the first concurrent webhook candidate", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "pending",
        setupPhase: "draft",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )

    const retained = await Promise.all([
      withOrgDbContext(storageOrgId, () =>
        persistPagerdutyWebhookSubscriptionIfAbsent({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          webhookSubscriptionId: `PFSUB_A_${storageSuffix}`,
          webhookSecret: "webhook-secret-a",
        }),
      ),
      withOrgDbContext(storageOrgId, () =>
        persistPagerdutyWebhookSubscriptionIfAbsent({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          webhookSubscriptionId: `PFSUB_B_${storageSuffix}`,
          webhookSecret: "webhook-secret-b",
        }),
      ),
    ])

    expect(retained[0]).toBe(retained[1])
    expect([`PFSUB_A_${storageSuffix}`, `PFSUB_B_${storageSuffix}`]).toContain(
      retained[0],
    )
    const stored = await readConnection(connectionId)
    expect(stored).toMatchObject({
      status: "installed",
      webhookSubscriptionId: retained[0],
      webhookSecretEnc: expect.stringMatching(/^ctxv1:/),
    })
  })

  it("does not report a deleted connection as webhook-ready", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "pending",
        setupPhase: "draft",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )
    const webhookId = `PFSUB_DEL_${storageSuffix}`
    await withOrgDbContext(storageOrgId, () =>
      persistPagerdutyWebhookSubscriptionIfAbsent({
        orgId: storageOrgId,
        connectionId,
        env: storageEnv,
        webhookSubscriptionId: webhookId,
        webhookSecret: "webhook-secret",
      }),
    )
    await withOrgDbContext(storageOrgId, () =>
      deletePagerdutyConnectionById(storageOrgId, connectionId),
    )

    await expect(
      listPagerdutyConnectionsByWebhookSubscriptionId({
        webhookSubscriptionId: webhookId,
        env: storageEnv,
      }),
    ).resolves.toEqual([])
    await expect(
      withOrgDbContext(storageOrgId, () =>
        persistPagerdutyWebhookSubscriptionIfAbsent({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          webhookSubscriptionId: webhookId,
          webhookSecret: "webhook-secret",
        }),
      ),
    ).rejects.toThrow("PagerDuty connection not found")
  })

  it("does not allow changing the OAuth app after tokens are issued", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "pending",
        setupPhase: "draft",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )

    await expect(
      withOrgDbContext(storageOrgId, () =>
        savePagerdutyOAuthApp({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          clientId: "replacement-client",
          clientSecret: "replacement-secret",
        }),
      ),
    ).rejects.toThrow(
      "PagerDuty OAuth app cannot be changed after account authorisation",
    )
    const stored = await readConnection(connectionId)
    expect(stored?.oauthClientId).toBeNull()
  })

  it("does not revoke credentials replaced after a stale request began", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "installed",
        setupPhase: "live",
        repositoryId: "repo_1",
        branch: "main",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )

    await expect(
      withOrgDbContext(storageOrgId, () =>
        recordPagerdutyOAuthRevocation({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          expectedAccessToken: "stale-access",
        }),
      ),
    ).resolves.toBe(false)
    const stored = await readConnection(connectionId)
    expect(stored).toMatchObject({
      status: "installed",
      accessToken: "access-old",
    })
  })

  it("does not reuse an authorised pending connection as a draft", async () => {
    const authorisedId = generateObjectId("con")
    await insertConnection(
      authorisedId,
      storedConfig({
        accountId: "acme",
        status: "pending",
        setupPhase: "draft",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )

    const draft = await withOrgDbContext(storageOrgId, () =>
      createOrReusePagerdutyDraft({
        orgId: storageOrgId,
        env: storageEnv,
        ownerUserId: "user_pd_store",
      }),
    )

    expect(draft.id).not.toBe(authorisedId)
    expect(draft.accountId).toMatch(/^pending:con_/)
    expect(draft.accessToken).toBeNull()
    await expect(readConnection(authorisedId)).resolves.toMatchObject({
      id: authorisedId,
      accountId: "acme",
      accessToken: "access-old",
    })
  })

  it("reuses a placeholder draft instead of creating another", async () => {
    const first = await withOrgDbContext(storageOrgId, () =>
      createOrReusePagerdutyDraft({
        orgId: storageOrgId,
        env: storageEnv,
        ownerUserId: "user_pd_store",
      }),
    )
    const second = await withOrgDbContext(storageOrgId, () =>
      createOrReusePagerdutyDraft({
        orgId: storageOrgId,
        env: storageEnv,
        ownerUserId: "user_pd_store",
      }),
    )
    expect(second.id).toBe(first.id)
    expect(second.accountId).toBe(`pending:${first.id}`)
    const listed = await withOrgDbContext(storageOrgId, () =>
      listPagerdutyConnectionsForOrg(storageOrgId, storageEnv),
    )
    expect(listed).toHaveLength(1)
  })

  it("serialises stale refreshes", async () => {
    const connectionId = generateObjectId("con")
    await insertConnection(
      connectionId,
      storedConfig({
        accountId: "acme",
        status: "installed",
        setupPhase: "live",
        repositoryId: "repo_rebound",
        branch: "release",
        accessToken: "access-old",
        refreshToken: "refresh-old",
      }),
    )
    let refreshCalls = 0
    const refresh = async () => {
      refreshCalls += 1
      return {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
        accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      }
    }

    const results = await Promise.all([
      withOrgDbContext(storageOrgId, () =>
        refreshPagerdutyConnectionTokensWithLock({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          expectedRefreshToken: "refresh-old",
          expectedAccessToken: "access-old",
          refresh,
        }),
      ),
      withOrgDbContext(storageOrgId, () =>
        refreshPagerdutyConnectionTokensWithLock({
          orgId: storageOrgId,
          connectionId,
          env: storageEnv,
          expectedRefreshToken: "refresh-old",
          expectedAccessToken: "access-old",
          refresh,
        }),
      ),
    ])

    expect(refreshCalls).toBe(1)
    expect(results).toEqual([
      {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
        accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      },
      {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
        accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      },
    ])
    const stored = await readConnection(connectionId)
    expect(stored).toMatchObject({
      accessToken: "access-fresh",
      refreshToken: "refresh-rotated",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
    })
  })

  it("clears every binding for a deleted repository", async () => {
    const firstId = generateObjectId("con")
    const secondId = generateObjectId("con")
    await insertConnection(
      firstId,
      storedConfig({
        accountId: "acme-one",
        status: "installed",
        setupPhase: "live",
        repositoryId: "repo_1",
        branch: "main",
        accessToken: "access-one",
        refreshToken: "refresh-one",
      }),
    )
    await insertConnection(
      secondId,
      storedConfig({
        accountId: "acme-two",
        status: "installed",
        setupPhase: "live",
        repositoryId: "repo_1",
        branch: "main",
        accessToken: "access-two",
        refreshToken: "refresh-two",
      }),
    )

    await expect(
      withOrgDbContext(storageOrgId, () =>
        clearPagerdutySyncBindingsForRepository({
          orgId: storageOrgId,
          repositoryId: "repo_1",
        }),
      ),
    ).resolves.toBe(2)
    await expect(
      getPagerdutyBindingByConnectionId(storageOrgId, firstId),
    ).resolves.toBeUndefined()
    await expect(
      getPagerdutyBindingByConnectionId(storageOrgId, secondId),
    ).resolves.toBeUndefined()
    await expect(readConnection(firstId)).resolves.toMatchObject({
      repositoryId: null,
      branch: null,
      enabled: false,
      setupPhase: "draft",
      accessToken: "access-one",
    })
    await expect(readConnection(secondId)).resolves.toMatchObject({
      repositoryId: null,
      branch: null,
      enabled: false,
      setupPhase: "draft",
      accessToken: "access-two",
    })
  })
})
