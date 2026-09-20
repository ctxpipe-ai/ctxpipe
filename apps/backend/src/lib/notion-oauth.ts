import { createHmac, timingSafeEqual } from "node:crypto"
import type { Env } from "../config/env.js"
import { decryptConnectionSecret } from "./connection-secrets.js"
import type { NotionConnectionConfig } from "./connection-config.js"

export const NOTION_WEBHOOK_PROVISIONING_CONTEXT =
  "ctxpipe:notion-webhook-provisioning:v1"

export type NotionOAuthApp = {
  clientId: string
  clientSecret: string
}

/** Row app first; hosted env fallback when the row has no client id/secret. */
export function resolveNotionOAuthApp(
  stored: NotionConnectionConfig | null | undefined,
  env: Env,
): NotionOAuthApp | undefined {
  if (stored?.oauthClientId && stored.oauthClientSecretEnc) {
    return {
      clientId: stored.oauthClientId,
      clientSecret: decryptConnectionSecret(stored.oauthClientSecretEnc, env),
    }
  }
  if (env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET) {
    return {
      clientId: env.NOTION_CLIENT_ID,
      clientSecret: env.NOTION_CLIENT_SECRET,
    }
  }
  return undefined
}

/** Row verification token first; hosted `NOTION_WEBHOOK_SECRET` fallback. */
export function resolveNotionWebhookSecret(
  stored: NotionConnectionConfig | null | undefined,
  env: Env,
): string | undefined {
  if (stored?.webhookSecretEnc) {
    return decryptConnectionSecret(stored.webhookSecretEnc, env)
  }
  return env.NOTION_WEBHOOK_SECRET
}

export function notionConnectionHasOauthApp(
  stored: NotionConnectionConfig | null | undefined,
): boolean {
  return Boolean(stored?.oauthClientId && stored.oauthClientSecretEnc)
}

export function notionConnectionHasWebhookSecret(
  stored: NotionConnectionConfig | null | undefined,
): boolean {
  return Boolean(stored?.webhookSecretEnc)
}

export function notionProvisioningToken(clientSecret: string): string {
  return createHmac("sha256", clientSecret)
    .update(NOTION_WEBHOOK_PROVISIONING_CONTEXT)
    .digest("base64url")
}

export function notionProvisioningTokenMatches(
  clientSecret: string,
  supplied: string,
): boolean {
  const expected = notionProvisioningToken(clientSecret)
  if (supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

export function hasValidNotionSignature(
  rawBody: string,
  signature: string | undefined,
  verificationToken: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false
  const expected = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`
  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

export function notionRedirectUri(input: {
  AUTH_BASE_URL: string
  NOTION_REDIRECT_URI?: string
}): string {
  if (input.NOTION_REDIRECT_URI) return input.NOTION_REDIRECT_URI
  return `${input.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/connectors/notion/oauth/callback`
}

export function notionWebhookUrl(input: {
  AUTH_BASE_URL: string
  connectionId?: string
  clientSecret?: string
}): string {
  const base = `${input.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/notion`
  if (!input.connectionId || !input.clientSecret) return base
  const url = new URL(base)
  url.searchParams.set("connectionId", input.connectionId)
  url.searchParams.set(
    "provisioningToken",
    notionProvisioningToken(input.clientSecret),
  )
  return url.toString()
}

export function notionOauthAppFieldsFromStored(
  stored: NotionConnectionConfig | null | undefined,
): Pick<
  NotionConnectionConfig,
  "oauthClientId" | "oauthClientSecretEnc" | "webhookSecretEnc"
> {
  return {
    oauthClientId: stored?.oauthClientId,
    oauthClientSecretEnc: stored?.oauthClientSecretEnc,
    webhookSecretEnc: stored?.webhookSecretEnc,
  }
}
