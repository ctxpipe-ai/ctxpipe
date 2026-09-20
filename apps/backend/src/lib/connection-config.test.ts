import { describe, expect, it } from "vitest"
import { parseEnv } from "../config/env.js"
import type { Env } from "../config/env.js"
import {
  decodeNotionTokens,
  encodeNotionTokensForDb,
  migrateLegacyNotionTokensForDb,
  parseNotionConnectionConfig,
} from "./connection-config.js"
import { encryptConnectionSecret } from "./connection-secrets.js"
import {
  resolveNotionOAuthApp,
  resolveNotionWebhookSecret,
} from "./notion-oauth.js"

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

  it("round-trips oauth app and webhook secret ciphertext on the row", () => {
    const stored = parseNotionConnectionConfig({
      oauthClientId: "notion-client",
      oauthClientSecretEnc: encryptConnectionSecret("notion-secret", env),
      webhookSecretEnc: encryptConnectionSecret("verify-token", env),
    })
    expect(stored.oauthClientId).toBe("notion-client")
    expect(stored.oauthClientSecretEnc).toMatch(/^ctxv1:/)
    expect(stored.webhookSecretEnc).toMatch(/^ctxv1:/)
    expect(stored.oauthClientSecretEnc).not.toContain("notion-secret")
    expect(stored.webhookSecretEnc).not.toContain("verify-token")
  })
})

describe("parseEnv Notion optionals", () => {
  it("succeeds when all NOTION_* values are empty strings", () => {
    const parsed = parseEnv({
      DATABASE_URL: "postgresql://localhost/test",
      AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
      NOTION_CLIENT_ID: "",
      NOTION_CLIENT_SECRET: "",
      NOTION_REDIRECT_URI: "",
      NOTION_WEBHOOK_SECRET: "",
    })
    expect(parsed.NOTION_CLIENT_ID).toBeUndefined()
    expect(parsed.NOTION_CLIENT_SECRET).toBeUndefined()
    expect(parsed.NOTION_REDIRECT_URI).toBeUndefined()
    expect(parsed.NOTION_WEBHOOK_SECRET).toBeUndefined()
  })
})

describe("resolveNotionOAuthApp", () => {
  it("prefers decrypted row credentials over env", () => {
    const stored = parseNotionConnectionConfig({
      oauthClientId: "row-id",
      oauthClientSecretEnc: encryptConnectionSecret("row-secret", env),
    })
    const withEnv = {
      ...env,
      NOTION_CLIENT_ID: "env-id",
      NOTION_CLIENT_SECRET: "env-secret",
    } as Env
    expect(resolveNotionOAuthApp(stored, withEnv)).toEqual({
      clientId: "row-id",
      clientSecret: "row-secret",
    })
  })

  it("falls back to env when the row has no app", () => {
    const withEnv = {
      ...env,
      NOTION_CLIENT_ID: "env-id",
      NOTION_CLIENT_SECRET: "env-secret",
    } as Env
    expect(resolveNotionOAuthApp(undefined, withEnv)).toEqual({
      clientId: "env-id",
      clientSecret: "env-secret",
    })
  })

  it("returns undefined when neither row nor env has both fields", () => {
    expect(resolveNotionOAuthApp(undefined, env)).toBeUndefined()
    expect(
      resolveNotionOAuthApp(
        parseNotionConnectionConfig({ oauthClientId: "only-id" }),
        env,
      ),
    ).toBeUndefined()
  })
})

describe("resolveNotionWebhookSecret", () => {
  it("prefers the row verification token over env", () => {
    const stored = parseNotionConnectionConfig({
      webhookSecretEnc: encryptConnectionSecret("row-hook", env),
    })
    const withEnv = { ...env, NOTION_WEBHOOK_SECRET: "env-hook" } as Env
    expect(resolveNotionWebhookSecret(stored, withEnv)).toBe("row-hook")
  })

  it("falls back to env when the row has no webhook secret", () => {
    const withEnv = { ...env, NOTION_WEBHOOK_SECRET: "env-hook" } as Env
    expect(resolveNotionWebhookSecret(undefined, withEnv)).toBe("env-hook")
  })
})
