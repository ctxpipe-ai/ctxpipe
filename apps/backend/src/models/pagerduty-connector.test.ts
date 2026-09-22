import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  encodePagerdutyOAuthClientSecretForDb,
  encodePagerdutyTokensForDb,
  type PagerdutySetupPhase,
} from "../lib/connection-config.js"
import {
  claimPagerdutyBindingInitialSync,
  clearPagerdutySyncBindingsForRepository,
  createOrReusePagerdutyDraft,
  finalizePagerdutyBindingAfterContentWorkflow,
  pagerdutyOAuthAppMetadata,
  persistPagerdutyWebhookSubscriptionIfAbsent,
  planPagerdutySyncBindingUpdate,
  recordPagerdutyOAuthRevocation,
  refreshPagerdutyConnectionTokensWithLock,
  savePagerdutyOAuthApp,
  upsertPagerdutyConnectionFromOAuth,
} from "./pagerduty-connector.js"

const dbMocks = vi.hoisted(() => ({
  getOrgDb: vi.fn(),
  getSystemDb: vi.fn(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return {
    ...actual,
    getOrgDb: dbMocks.getOrgDb,
    getSystemDb: dbMocks.getSystemDb,
  }
})

const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
  PAGERDUTY_CLIENT_ID: "hosted-client",
  PAGERDUTY_CLIENT_SECRET: "hosted-secret",
} as unknown as Env

function pagerdutyConnectionRow(
  setupPhase: PagerdutySetupPhase,
  overrides: {
    enabled?: boolean
    repositoryId?: string
    branch?: string
    status?: "pending" | "installed" | "revoked"
  } = {},
) {
  return {
    id: "con_pagerduty",
    orgId: "org_1",
    type: "pagerduty",
    config: {
      ...encodePagerdutyTokensForDb(
        { accessToken: "access-old", refreshToken: "refresh-old" },
        env,
      ),
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      ownerUserId: "user_1",
      status: overrides.status ?? "installed",
      repositoryId: overrides.repositoryId ?? "repo_1",
      branch: overrides.branch ?? "main",
      enabled: overrides.enabled ?? true,
      setupPhase,
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function systemDb(
  setupPhase: PagerdutySetupPhase,
  overrides?: {
    enabled?: boolean
    repositoryId?: string
    branch?: string
    status?: "pending" | "installed" | "revoked"
  },
) {
  const row = pagerdutyConnectionRow(setupPhase, overrides)
  const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
    where: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: row.id }]),
    })),
  }))
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set })),
  }
  const db = {
    transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
    ),
  } as unknown as Db
  return { db, set }
}

describe("planPagerdutySyncBindingUpdate", () => {
  it("resets lifecycle when the repository or branch changes", () => {
    expect(
      planPagerdutySyncBindingUpdate({
        existing: {
          id: "con_pagerduty",
          orgId: "org_1",
          connectionId: "con_pagerduty",
          repositoryId: "repo_1",
          branch: "main",
          enabled: true,
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        repositoryId: "repo_2",
        branch: "main",
        enabled: true,
      }),
    ).toEqual({
      changed: true,
      repositoryOrBranchChanged: true,
      resetLifecycle: true,
    })
  })
})

describe("PagerDuty connector lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    "awaiting_merge",
    "sync_failed",
    "live",
  ] as const)("claims initial sync from %s", async (setupPhase) => {
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimPagerdutyBindingInitialSync({
        connectionId: "con_pagerduty",
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
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimPagerdutyBindingInitialSync({
        connectionId: "con_pagerduty",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("does not claim initial sync for a revoked connection", async () => {
    const { db } = systemDb("live", { status: "revoked" })
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimPagerdutyBindingInitialSync({
        connectionId: "con_pagerduty",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("finalizes completed content sync as live", async () => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await finalizePagerdutyBindingAfterContentWorkflow({
      connectionId: "con_pagerduty",
      workflowStatus: "completed",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })

  it("finalizes a revoked in-flight sync as failed", async () => {
    const { db, set } = systemDb("initial_sync", { status: "revoked" })
    dbMocks.getSystemDb.mockReturnValue(db)

    await finalizePagerdutyBindingAfterContentWorkflow({
      connectionId: "con_pagerduty",
      workflowStatus: "completed",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })
})

describe("PagerDuty connection storage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("locks OAuth upserts and preserves the latest binding", async () => {
    const matched = {
      ...pagerdutyConnectionRow("live", {
        repositoryId: "repo_old",
        branch: "main",
      }),
      config: {
        ...pagerdutyConnectionRow("live", {
          repositoryId: "repo_old",
          branch: "main",
        }).config,
        status: "revoked",
        enabled: false,
        webhookSubscriptionId: "PFXXXX",
        webhookSecretEnc: "ctxv1:keep",
        oauthClientId: "old-row-client",
        oauthClientSecretEnc: encodePagerdutyOAuthClientSecretForDb(
          "old-row-secret",
          env,
        ),
      },
    }
    const latest = {
      ...matched,
      config: {
        ...matched.config,
        repositoryId: "repo_rebound",
        branch: "release",
      },
    }
    let updatedConfig: Record<string, unknown> | undefined
    const returning = vi.fn(async () => [
      { ...latest, config: updatedConfig ?? latest.config },
    ])
    const set = vi.fn((value: { config: Record<string, unknown> }) => {
      updatedConfig = value.config
      return { where: vi.fn(() => ({ returning })) }
    })
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([matched]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([latest]),
          })),
        })),
      })
    const tx = {
      execute: vi.fn(),
      select,
      update: vi.fn(() => ({ set })),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const result = await upsertPagerdutyConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: "user_pd",
      oauthApp: {
        clientId: "hosted-client",
        clientSecret: "hosted-secret",
      },
    })

    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: "repo_rebound",
          branch: "release",
          enabled: true,
          webhookSubscriptionId: "PFXXXX",
        }),
      }),
    )
    expect(result).toMatchObject({
      accessToken: "new_access",
      refreshToken: "new_refresh",
      repositoryId: "repo_rebound",
      branch: "release",
    })
    expect(updatedConfig?.oauthClientId).toBeUndefined()
    expect(updatedConfig?.oauthClientSecretEnc).toBeUndefined()
  })

  it("merges a self-host draft into the existing account connection", async () => {
    const draft = {
      ...pagerdutyConnectionRow("draft", {
        repositoryId: undefined,
        branch: undefined,
      }),
      id: "con_draft",
      config: {
        accountId: "pending:con_draft",
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        region: "us",
        ownerUserId: "user_1",
        status: "pending",
        setupPhase: "draft",
        oauthClientId: "row-client",
        oauthClientSecretEnc: encodePagerdutyOAuthClientSecretForDb(
          "row-secret",
          env,
        ),
      },
    }
    const matched = {
      ...pagerdutyConnectionRow("live"),
      id: "con_existing",
      config: {
        ...pagerdutyConnectionRow("live").config,
        webhookSubscriptionId: "PFSUB",
        webhookSecretEnc: "ctxv1:stored-webhook-secret",
      },
    }
    let updatedConfig: Record<string, unknown> | undefined
    const returning = vi.fn(async () => [
      { ...matched, config: updatedConfig ?? matched.config },
    ])
    const set = vi.fn((value: { config: Record<string, unknown> }) => {
      updatedConfig = value.config
      return { where: vi.fn(() => ({ returning })) }
    })
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([draft]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([matched]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([matched]),
          })),
        })),
      })
    const deleteReturning = vi.fn().mockResolvedValue([{ id: "con_draft" }])
    const deleteWhere = vi.fn(() => ({ returning: deleteReturning }))
    const tx = {
      execute: vi.fn(),
      select,
      update: vi.fn(() => ({ set })),
      delete: vi.fn(() => ({ where: deleteWhere })),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const result = await upsertPagerdutyConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: "user_pd",
      oauthApp: { clientId: "row-client", clientSecret: "row-secret" },
      connectionId: "con_draft",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          status: "installed",
          repositoryId: "repo_1",
          webhookSubscriptionId: "PFSUB",
          oauthClientId: "row-client",
          oauthClientSecretEnc: draft.config.oauthClientSecretEnc,
        }),
      }),
    )
    expect(tx.delete).toHaveBeenCalled()
    expect(deleteWhere).toHaveBeenCalled()
    expect(deleteReturning).toHaveBeenCalled()
    expect(result.id).toBe("con_existing")
  })

  it("keeps a new connection pending until its webhook secret is stored", async () => {
    const draft = {
      ...pagerdutyConnectionRow("draft", {
        repositoryId: undefined,
        branch: undefined,
      }),
      id: "con_draft",
      config: {
        accountId: "pending:con_draft",
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        region: "us",
        ownerUserId: "user_1",
        status: "pending",
        setupPhase: "draft",
      },
    }
    let updatedConfig: Record<string, unknown> | undefined
    const returning = vi.fn(async () => [
      { ...draft, config: updatedConfig ?? draft.config },
    ])
    const set = vi.fn((value: { config: Record<string, unknown> }) => {
      updatedConfig = value.config
      return { where: vi.fn(() => ({ returning })) }
    })
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([draft]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([draft]),
          })),
        })),
      })
    const tx = {
      execute: vi.fn(),
      select,
      update: vi.fn(() => ({ set })),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const result = await upsertPagerdutyConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: "user_pd",
      oauthApp: {
        clientId: "hosted-client",
        clientSecret: "hosted-secret",
      },
      connectionId: "con_draft",
    })

    expect(result.status).toBe("pending")
    expect(updatedConfig).toEqual(
      expect.objectContaining({ status: "pending" }),
    )
  })

  it("checks the authorised account while holding the draft lock", async () => {
    const draft = {
      ...pagerdutyConnectionRow("draft"),
      id: "con_draft",
      config: {
        accountId: "pending:con_draft",
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        region: "us",
        ownerUserId: "user_1",
        status: "pending",
        setupPhase: "draft",
      },
    }
    const authorised = {
      ...draft,
      config: {
        ...draft.config,
        accountId: "first-account",
        accountName: "First account",
        accountSubdomain: "first",
        ...encodePagerdutyTokensForDb(
          { accessToken: "first-access", refreshToken: "first-refresh" },
          env,
        ),
      },
    }
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([authorised]),
        })),
      })),
    }))
    const update = vi.fn()
    const tx = { execute: vi.fn(), select, update }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      upsertPagerdutyConnectionFromOAuth({
        orgId: "org_1",
        env,
        ownerUserId: "user_1",
        accessToken: "second-access",
        refreshToken: "second-refresh",
        accessTokenExpiresAt: null,
        accountId: "second-account",
        accountName: "Second account",
        accountSubdomain: "second",
        region: "us",
        actorUserId: "user_pd",
        oauthApp: {
          clientId: "hosted-client",
          clientSecret: "hosted-secret",
        },
        connectionId: "con_draft",
      }),
    ).rejects.toThrow(
      "PagerDuty authorised account does not match this connection",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("rejects tokens when the row OAuth app changed during authorisation", async () => {
    const draft = {
      ...pagerdutyConnectionRow("draft"),
      id: "con_draft",
      config: {
        accountId: "pending:con_draft",
        accountName: "Pending PagerDuty account",
        accountSubdomain: "pending",
        region: "us",
        ownerUserId: "user_1",
        status: "pending",
        setupPhase: "draft",
        oauthClientId: "replacement-client",
        oauthClientSecretEnc: encodePagerdutyOAuthClientSecretForDb(
          "replacement-secret",
          env,
        ),
      },
    }
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([draft]),
          })),
        })),
      })),
      update: vi.fn(),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      upsertPagerdutyConnectionFromOAuth({
        orgId: "org_1",
        env,
        ownerUserId: "user_1",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        accessTokenExpiresAt: null,
        accountId: "acme",
        accountName: "acme",
        accountSubdomain: "acme",
        region: "us",
        actorUserId: "user_pd",
        oauthApp: { clientId: "old-client", clientSecret: "old-secret" },
        connectionId: "con_draft",
      }),
    ).rejects.toThrow(
      "PagerDuty OAuth app changed during authorisation. Try again.",
    )
    expect(tx.update).not.toHaveBeenCalled()
  })

  it("retains the first concurrent webhook candidate", async () => {
    let row = {
      ...pagerdutyConnectionRow("draft"),
      config: {
        ...pagerdutyConnectionRow("draft").config,
        status: "pending",
      },
    }
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [row]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: { config: Record<string, unknown> }) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              row = { ...row, config: value.config, updatedAt: new Date() }
              return [{ id: row.id }]
            }),
          })),
        })),
      })),
    }
    let transactionTail = Promise.resolve()
    const db = {
      transaction: vi.fn(
        <T>(operation: (transaction: Db) => Promise<T>): Promise<T> => {
          const result = transactionTail.then(() =>
            operation(tx as unknown as Db),
          )
          transactionTail = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        },
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const retained = await Promise.all([
      persistPagerdutyWebhookSubscriptionIfAbsent({
        orgId: "org_1",
        connectionId: row.id,
        env,
        webhookSubscriptionId: "PFSUB_A",
        webhookSecret: "webhook-secret-a",
      }),
      persistPagerdutyWebhookSubscriptionIfAbsent({
        orgId: "org_1",
        connectionId: row.id,
        env,
        webhookSubscriptionId: "PFSUB_B",
        webhookSecret: "webhook-secret-b",
      }),
    ])

    expect(retained).toEqual(["PFSUB_A", "PFSUB_A"])
    expect(row.config).toEqual(
      expect.objectContaining({
        status: "installed",
        webhookSubscriptionId: "PFSUB_A",
        webhookSecretEnc: expect.stringMatching(/^ctxv1:/),
      }),
    )
  })

  it("does not report a deleted connection as webhook-ready", async () => {
    const row = {
      ...pagerdutyConnectionRow("draft"),
      config: {
        ...pagerdutyConnectionRow("draft").config,
        status: "pending",
      },
    }
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([row]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      persistPagerdutyWebhookSubscriptionIfAbsent({
        orgId: "org_1",
        connectionId: row.id,
        env,
        webhookSubscriptionId: "PFSUB",
        webhookSecret: "webhook-secret",
      }),
    ).rejects.toThrow(
      "PagerDuty connection was removed while saving its webhook",
    )
  })

  it("does not allow changing the OAuth app after tokens are issued", async () => {
    const row = pagerdutyConnectionRow("draft")
    const update = vi.fn()
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([row]),
          })),
        })),
      })),
      update,
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      savePagerdutyOAuthApp({
        orgId: "org_1",
        connectionId: row.id,
        env,
        clientId: "replacement-client",
        clientSecret: "replacement-secret",
      }),
    ).rejects.toThrow(
      "PagerDuty OAuth app cannot be changed after account authorisation",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("does not revoke credentials replaced after a stale request began", async () => {
    const row = pagerdutyConnectionRow("live")
    const update = vi.fn()
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([row]),
          })),
        })),
      })),
      update,
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      recordPagerdutyOAuthRevocation({
        orgId: "org_1",
        connectionId: row.id,
        env,
        expectedAccessToken: "stale-access",
      }),
    ).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it("does not reuse an authorised pending connection as a draft", async () => {
    const authorisedPending = {
      ...pagerdutyConnectionRow("draft"),
      config: {
        ...pagerdutyConnectionRow("draft").config,
        status: "pending",
      },
    }
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([authorisedPending]),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(
          (value: {
            id: string
            orgId: string
            type: string
            config: Record<string, unknown>
          }) => ({
            returning: vi.fn().mockResolvedValue([
              {
                ...value,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          }),
        ),
      })),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      createOrReusePagerdutyDraft({
        orgId: "org_1",
        env,
        ownerUserId: "user_1",
      }),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^con_/),
      accountId: expect.stringMatching(/^pending:con_/),
    })
  })

  it("reports an explicit redirect URI override to the setup wizard", () => {
    expect(
      pagerdutyOAuthAppMetadata(undefined, {
        ...env,
        AUTH_BASE_URL: "https://app.example.com",
        PAGERDUTY_REDIRECT_URI:
          "https://oauth.example.com/api/v1/integrations/pagerduty/callback",
      } as Env).oauthCallbackUrl,
    ).toBe("https://oauth.example.com/api/v1/integrations/pagerduty/callback")
  })

  it("serialises stale refreshes", async () => {
    const storedRow = pagerdutyConnectionRow("live", {
      repositoryId: "repo_rebound",
      branch: "release",
    })
    let row: Omit<typeof storedRow, "config"> & {
      config: Record<string, unknown>
    } = {
      ...storedRow,
      config: {
        ...storedRow.config,
      },
    }
    const set = vi.fn((value: { config: Record<string, unknown> }) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          row = { ...row, config: value.config, updatedAt: new Date() }
          return [{ id: row.id }]
        }),
      })),
    }))
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [row]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    }
    let transactionTail = Promise.resolve()
    const db = {
      transaction: vi.fn(
        <T>(operation: (transaction: Db) => Promise<T>): Promise<T> => {
          const result = transactionTail.then(() =>
            operation(tx as unknown as Db),
          )
          transactionTail = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        },
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)
    const refresh = vi.fn(async () => ({
      accessToken: "access-fresh",
      refreshToken: "refresh-rotated",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
    }))

    const results = await Promise.all([
      refreshPagerdutyConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_pagerduty",
        env,
        expectedRefreshToken: "refresh-old",
        expectedAccessToken: "access-old",
        refresh,
      }),
      refreshPagerdutyConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_pagerduty",
        env,
        expectedRefreshToken: "refresh-old",
        expectedAccessToken: "access-old",
        refresh,
      }),
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
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
  })

  it("clears every binding for a deleted repository", async () => {
    const row = pagerdutyConnectionRow("live")
    const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
      where: vi.fn().mockResolvedValue(undefined),
    }))
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([row]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    }
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi
            .fn()
            .mockResolvedValue([{ id: row.id }, { id: "con_pagerduty_2" }]),
        })),
      })),
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      clearPagerdutySyncBindingsForRepository({
        orgId: "org_1",
        repositoryId: "repo_1",
      }),
    ).resolves.toBe(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: null,
          branch: null,
          enabled: false,
          setupPhase: "draft",
        }),
      }),
    )
  })
})
