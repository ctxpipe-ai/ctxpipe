import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import {
  decodeLinearOauthClientSecret,
  decodeLinearWebhookSecret,
  decodeNotionTokens,
  encodeLinearOauthAppSecretsForDb,
  encodeNotionTokensForDb,
  migrateLegacyNotionTokensForDb,
  parseLinearConnectionStored,
  parseNotionConnectionConfig,
} from "./connection-config.js"

const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
} as unknown as Env

describe("Notion token encryption", () => {
  it("stores access and refresh tokens as ciphertext, not plaintext", () => {
    const encoded = encodeNotionTokensForDb(
      { accessToken: "ntn_access", refreshToken: "ntn_refresh" },
      env,
    )
    expect(encoded.accessTokenEnc).toMatch(/^ctxv1:/)
    expect(encoded.refreshTokenEnc).toMatch(/^ctxv1:/)
    expect(encoded.accessTokenEnc).not.toContain("ntn_access")
    expect(encoded.refreshTokenEnc).not.toContain("ntn_refresh")
  })

  it("omits refresh ciphertext when there is no refresh token", () => {
    const encoded = encodeNotionTokensForDb(
      { accessToken: "ntn_access", refreshToken: null },
      env,
    )
    expect(encoded.accessTokenEnc).toMatch(/^ctxv1:/)
    expect(encoded.refreshTokenEnc).toBeUndefined()
  })

  it("round-trips tokens through the stored config schema", () => {
    const stored = parseNotionConnectionConfig({
      ...encodeNotionTokensForDb(
        { accessToken: "ntn_access", refreshToken: "ntn_refresh" },
        env,
      ),
      botId: "bot_1",
    })
    expect(decodeNotionTokens(stored, env)).toEqual({
      accessToken: "ntn_access",
      refreshToken: "ntn_refresh",
    })
  })

  it("reads legacy plaintext tokens when no ciphertext is present", () => {
    const stored = parseNotionConnectionConfig({
      accessToken: "legacy_access",
      refreshToken: "legacy_refresh",
      botId: "bot_1",
    })
    expect(decodeNotionTokens(stored, env)).toEqual({
      accessToken: "legacy_access",
      refreshToken: "legacy_refresh",
    })
  })

  it("rewrites legacy plaintext tokens as ciphertext", () => {
    const migrated = migrateLegacyNotionTokensForDb(
      parseNotionConnectionConfig({
        accessToken: "legacy_access",
        refreshToken: "legacy_refresh",
        botId: "bot_1",
      }),
      env,
    )

    expect(migrated).not.toHaveProperty("accessToken")
    expect(migrated).not.toHaveProperty("refreshToken")
    expect(migrated?.accessTokenEnc).toMatch(/^ctxv1:/)
    expect(migrated?.refreshTokenEnc).toMatch(/^ctxv1:/)
    expect(
      decodeNotionTokens(parseNotionConnectionConfig(migrated ?? {}), env),
    ).toEqual({
      accessToken: "legacy_access",
      refreshToken: "legacy_refresh",
    })
  })

  it("prefers ciphertext over any lingering legacy plaintext", () => {
    const stored = parseNotionConnectionConfig({
      ...encodeNotionTokensForDb(
        { accessToken: "fresh_access", refreshToken: null },
        env,
      ),
      accessToken: "legacy_access",
      botId: "bot_1",
    })
    expect(decodeNotionTokens(stored, env)?.accessToken).toBe("fresh_access")
  })

  it("returns undefined when no tokens are present", () => {
    const stored = parseNotionConnectionConfig({ botId: "bot_1" })
    expect(decodeNotionTokens(stored, env)).toBeUndefined()
  })
})

describe("Linear OAuth app encryption", () => {
  it("stores client and webhook secrets as ciphertext", () => {
    const encoded = encodeLinearOauthAppSecretsForDb(
      {
        oauthClientId: "lin_client",
        oauthClientSecret: "lin_secret",
        webhookSecret: "lin_webhook",
      },
      env,
    )
    expect(encoded.oauthClientId).toBe("lin_client")
    expect(encoded.oauthClientSecretEnc).toMatch(/^ctxv1:/)
    expect(encoded.webhookSecretEnc).toMatch(/^ctxv1:/)
    expect(encoded.oauthClientSecretEnc).not.toContain("lin_secret")
    expect(encoded.webhookSecretEnc).not.toContain("lin_webhook")
    expect(decodeLinearOauthClientSecret(encoded, env)).toBe("lin_secret")
    expect(decodeLinearWebhookSecret(encoded, env)).toBe("lin_webhook")
  })

  it("parses a draft Linear config without workspace identity", () => {
    const stored = parseLinearConnectionStored({
      oauthClientId: "lin_client",
      setupPhase: "draft",
    })
    expect(stored.workspaceId).toBeUndefined()
    expect(stored.workspaceName).toBeUndefined()
    expect(stored.oauthClientId).toBe("lin_client")
    expect(stored.setupPhase).toBe("draft")
  })
})
