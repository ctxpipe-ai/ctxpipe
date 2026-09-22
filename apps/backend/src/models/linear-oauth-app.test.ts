import { describe, expect, it } from "vitest"
import { parseEnv, type Env } from "../config/env.js"
import { encryptConnectionSecret } from "../lib/connection-secrets.js"
import {
  envLinearOauthConfigured,
  getLinearOauthAppCreds,
  getLinearWebhookSecret,
  linearConnectionIsInstalled,
} from "./linear-oauth-app.js"

const env = {
  AUTH_SECRET: "linear-oauth-app-secret-that-is-long-enough",
  LINEAR_CLIENT_ID: "env-client",
  LINEAR_CLIENT_SECRET: "env-secret",
  LINEAR_WEBHOOK_SECRET: "env-webhook",
} as Env

describe("Linear OAuth app credentials", () => {
  it("prefers the connection row over env", () => {
    const creds = getLinearOauthAppCreds(
      {
        oauthClientId: "row-client",
        oauthClientSecretEnc: encryptConnectionSecret("row-secret", env),
      },
      env,
    )
    expect(creds).toEqual({ clientId: "row-client", clientSecret: "row-secret" })
  })

  it("falls back to env when the row has no app", () => {
    expect(getLinearOauthAppCreds(undefined, env)).toEqual({
      clientId: "env-client",
      clientSecret: "env-secret",
    })
  })

  it("treats empty LINEAR_* as unset", () => {
    const parsed = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      LINEAR_CLIENT_ID: "",
      LINEAR_CLIENT_SECRET: "",
      LINEAR_WEBHOOK_SECRET: "",
    } as Record<string, string | undefined>)
    expect(parsed.LINEAR_CLIENT_ID).toBeUndefined()
    expect(parsed.LINEAR_CLIENT_SECRET).toBeUndefined()
    expect(parsed.LINEAR_WEBHOOK_SECRET).toBeUndefined()
    expect(envLinearOauthConfigured(parsed)).toBe(false)
  })

  it("uses the row webhook secret and falls back to env", () => {
    expect(
      getLinearWebhookSecret(
        {
          webhookSecretEnc: encryptConnectionSecret("row-webhook", env),
        },
        env,
      ),
    ).toBe("row-webhook")
    expect(getLinearWebhookSecret(undefined, env)).toBe("env-webhook")
  })

  it("treats drafts without tokens as not installed", () => {
    expect(
      linearConnectionIsInstalled({
        status: "installed",
        accessToken: null,
        workspaceId: null,
      }),
    ).toBe(false)
    expect(
      linearConnectionIsInstalled({
        status: "installed",
        accessToken: "tok",
        workspaceId: "ws",
      }),
    ).toBe(true)
  })
})
