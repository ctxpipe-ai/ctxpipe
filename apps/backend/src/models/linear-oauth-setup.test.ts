import { describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  decodeLinearOauthClientSecret,
  decodeLinearWebhookSecret,
  encodeLinearOauthAppSecretsForDb,
  linearOauthAppSavedInConfig,
} from "../lib/connection-config.js"
import { encryptConnectionSecret } from "../lib/connection-secrets.js"
import {
  LinearWorkspaceCollisionError,
  listLinearWebhookConnectionsByWorkspaceId,
  saveLinearOauthAppOnConnection,
  upsertLinearConnectionFromOAuth,
  upsertLinearDraftConnection,
} from "./linear-connector.js"

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
  AUTH_SECRET: "linear-oauth-setup-secret-that-is-long-enough",
} as Env

function linearRow(input: { id: string; config: Record<string, unknown> }) {
  return {
    id: input.id,
    orgId: "org_1",
    type: "linear",
    config: input.config,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function thenableRows(rows: unknown[]) {
  const query = {
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  }
  return query
}

function orgDb(selectQueues: unknown[][], updateId = "con_updated") {
  let selectIndex = 0
  const deletedIds: string[] = []
  let lastUpdate: Record<string, unknown> | undefined
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => thenableRows(selectQueues[selectIndex++] ?? [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => [
          linearRow({
            id: typeof values.id === "string" ? values.id : "con_new",
            config: (values.config ?? {}) as Record<string, unknown>,
          }),
        ]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        lastUpdate = values
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [
              linearRow({
                id: updateId,
                config: (values.config ?? {}) as Record<string, unknown>,
              }),
            ]),
          })),
        }
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        deletedIds.push("deleted")
        return Promise.resolve()
      }),
    })),
  }
  dbMocks.getOrgDb.mockReturnValue({
    transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as Db)
  return { tx, deletedIds, getLastUpdate: () => lastUpdate }
}

describe("Linear OAuth app save predicate", () => {
  it("requires client id and both encrypted secrets", () => {
    expect(
      linearOauthAppSavedInConfig({
        oauthClientId: "lin_client",
        oauthClientSecretEnc: "enc-secret",
      }),
    ).toBe(false)
    expect(
      linearOauthAppSavedInConfig({
        oauthClientId: "lin_client",
        oauthClientSecretEnc: "enc-secret",
        webhookSecretEnc: "enc-hook",
      }),
    ).toBe(true)
  })
})

describe("upsertLinearDraftConnection", () => {
  it("reuses the only empty-workspace draft", async () => {
    const draft = linearRow({
      id: "con_draft",
      config: { setupPhase: "draft", ownerUserId: "user_1" },
    })
    orgDb([[draft]])
    const result = await upsertLinearDraftConnection({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
    })
    expect(result).toMatchObject({
      status: "ok",
      connection: { id: "con_draft" },
    })
  })

  it("returns ambiguous when two empty-workspace drafts exist", async () => {
    orgDb([
      [
        linearRow({ id: "con_a", config: { setupPhase: "draft" } }),
        linearRow({ id: "con_b", config: { setupPhase: "draft" } }),
      ],
    ])
    expect(
      await upsertLinearDraftConnection({
        orgId: "org_1",
        env,
        ownerUserId: "user_1",
      }),
    ).toEqual({ status: "ambiguous" })
  })
})

describe("saveLinearOauthAppOnConnection", () => {
  it("requires both secrets on first save and keeps them when omitted later", async () => {
    const unsaved = linearRow({
      id: "con_draft",
      config: { setupPhase: "draft", ownerUserId: "user_1" },
    })
    orgDb([[unsaved]])
    expect(
      await saveLinearOauthAppOnConnection({
        orgId: "org_1",
        connectionId: "con_draft",
        env,
        clientId: "lin_client",
      }),
    ).toBe("secret_required")

    const { getLastUpdate } = orgDb([[unsaved]])
    expect(
      await saveLinearOauthAppOnConnection({
        orgId: "org_1",
        connectionId: "con_draft",
        env,
        clientId: "lin_client",
        clientSecret: "lin_secret",
        webhookSecret: "lin_webhook",
      }),
    ).toBe("ok")
    const firstConfig = getLastUpdate()?.config as Record<string, unknown>
    expect(firstConfig.oauthClientId).toBe("lin_client")
    expect(typeof firstConfig.oauthClientSecretEnc).toBe("string")
    expect(typeof firstConfig.webhookSecretEnc).toBe("string")
    expect(
      decodeLinearOauthClientSecret(
        { oauthClientSecretEnc: firstConfig.oauthClientSecretEnc as string },
        env,
      ),
    ).toBe("lin_secret")
    expect(
      decodeLinearWebhookSecret(
        { webhookSecretEnc: firstConfig.webhookSecretEnc as string },
        env,
      ),
    ).toBe("lin_webhook")

    const saved = linearRow({
      id: "con_draft",
      config: firstConfig,
    })
    const update = orgDb([[saved]])
    expect(
      await saveLinearOauthAppOnConnection({
        orgId: "org_1",
        connectionId: "con_draft",
        env,
        clientId: "lin_client",
      }),
    ).toBe("ok")
    const kept = update.getLastUpdate()?.config as Record<string, unknown>
    expect(kept.oauthClientSecretEnc).toBe(firstConfig.oauthClientSecretEnc)
    expect(kept.webhookSecretEnc).toBe(firstConfig.webhookSecretEnc)
  })
})

describe("upsertLinearConnectionFromOAuth", () => {
  it("copies draft app secrets onto the workspace row and deletes the unused draft", async () => {
    const secrets = encodeLinearOauthAppSecretsForDb(
      {
        oauthClientId: "draft-client",
        oauthClientSecret: "draft-secret",
        webhookSecret: "draft-webhook",
      },
      env,
    )
    const workspace = linearRow({
      id: "con_workspace",
      config: {
        workspaceId: "ws_1",
        workspaceName: "Acme",
        ownerUserId: "user_1",
        accessTokenEnc: encryptConnectionSecret("old-token", env),
        setupPhase: "draft",
      },
    })
    const draft = linearRow({
      id: "con_draft",
      config: {
        setupPhase: "draft",
        ownerUserId: "user_1",
        ...secrets,
      },
    })
    const { deletedIds, getLastUpdate } = orgDb(
      [[workspace], [workspace], [draft]],
      "con_workspace",
    )
    const connection = await upsertLinearConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      workspaceId: "ws_1",
      workspaceName: "Acme",
      workspaceUrlKey: "acme",
      actorUserId: "actor_1",
      connectionId: "con_draft",
    })
    expect(connection.id).toBe("con_workspace")
    const written = getLastUpdate()?.config as Record<string, unknown>
    expect(written.oauthClientId).toBe("draft-client")
    expect(written.webhookSecretEnc).toBe(secrets.webhookSecretEnc)
    expect(deletedIds).toEqual(["deleted"])
  })

  it("rejects an installed connection colliding with another workspace row", async () => {
    const workspace = linearRow({
      id: "con_workspace",
      config: {
        workspaceId: "ws_1",
        workspaceName: "Acme",
        ownerUserId: "user_1",
        accessTokenEnc: encryptConnectionSecret("workspace-token", env),
        status: "installed",
        setupPhase: "live",
      },
    })
    const installedSource = linearRow({
      id: "con_installed",
      config: {
        workspaceId: "ws_other",
        workspaceName: "Other",
        ownerUserId: "user_1",
        accessTokenEnc: encryptConnectionSecret("source-token", env),
        status: "installed",
        setupPhase: "live",
      },
    })
    const { tx, deletedIds, getLastUpdate } = orgDb(
      [[workspace], [workspace], [installedSource]],
      "con_workspace",
    )
    await expect(
      upsertLinearConnectionFromOAuth({
        orgId: "org_1",
        env,
        ownerUserId: "user_1",
        accessToken: "new-token",
        refreshToken: null,
        accessTokenExpiresAt: null,
        workspaceId: "ws_1",
        workspaceName: "Acme",
        workspaceUrlKey: "acme",
        actorUserId: "actor_1",
        connectionId: "con_installed",
      }),
    ).rejects.toBeInstanceOf(LinearWorkspaceCollisionError)
    expect(deletedIds).toEqual([])
    expect(tx.update).not.toHaveBeenCalled()
    expect(getLastUpdate()).toBeUndefined()
  })
})

describe("listLinearWebhookConnectionsByWorkspaceId", () => {
  it("decrypts the webhook secret without reading user tokens", async () => {
    const webhookSecretEnc = encryptConnectionSecret("row-webhook", env)
    dbMocks.getSystemDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            linearRow({
              id: "con_linear",
              config: {
                workspaceId: "ws_1",
                workspaceName: "Acme",
                ownerUserId: "user_1",
                accessTokenEnc: "ctxv1:not-valid-ciphertext",
                webhookSecretEnc,
                status: "installed",
              },
            }),
          ]),
        })),
      })),
    } as unknown as Db)
    await expect(
      listLinearWebhookConnectionsByWorkspaceId("ws_1", env),
    ).resolves.toEqual([
      {
        id: "con_linear",
        orgId: "org_1",
        status: "installed",
        webhookSecret: "row-webhook",
      },
    ])
  })
})
