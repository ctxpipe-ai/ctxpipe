import type { Env } from "../config/env.js"
import {
  decodeLinearOauthClientSecret,
  decodeLinearWebhookSecret,
} from "../lib/connection-config.js"
import type { LinearConnectionShape } from "./connection-rows.js"

export type LinearOauthAppCreds = {
  clientId: string
  clientSecret: string
}

export function getLinearOauthAppCreds(
  connection:
    | Pick<LinearConnectionShape, "oauthClientId" | "oauthClientSecretEnc">
    | undefined,
  env: Env,
): LinearOauthAppCreds | undefined {
  if (connection?.oauthClientId && connection.oauthClientSecretEnc) {
    try {
      const clientSecret = decodeLinearOauthClientSecret(
        { oauthClientSecretEnc: connection.oauthClientSecretEnc },
        env,
      )
      if (clientSecret) {
        return { clientId: connection.oauthClientId, clientSecret }
      }
    } catch {
      // Fall through to env fallback.
    }
  }
  if (env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET) {
    return {
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    }
  }
  return undefined
}

export function getLinearWebhookSecret(
  connection: Pick<LinearConnectionShape, "webhookSecretEnc"> | undefined,
  env: Env,
): string | undefined {
  if (connection?.webhookSecretEnc) {
    try {
      const secret = decodeLinearWebhookSecret(
        { webhookSecretEnc: connection.webhookSecretEnc },
        env,
      )
      if (secret) return secret
    } catch {
      // Fall through to env fallback.
    }
  }
  return env.LINEAR_WEBHOOK_SECRET
}

export function envLinearOauthConfigured(env: Env): boolean {
  return Boolean(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET)
}

export function linearAccessToken(
  connection: Pick<LinearConnectionShape, "accessToken">,
): string {
  if (!connection.accessToken) {
    throw new Error("Linear connection is missing OAuth credentials")
  }
  return connection.accessToken
}

export function linearWorkspaceIdentity(
  connection: Pick<LinearConnectionShape, "workspaceId" | "workspaceName">,
): { workspaceId: string; workspaceName: string } {
  if (!connection.workspaceId || !connection.workspaceName) {
    throw new Error("Linear connection is missing workspace identity")
  }
  return {
    workspaceId: connection.workspaceId,
    workspaceName: connection.workspaceName,
  }
}

export function linearConnectionIsInstalled(
  connection: Pick<
    LinearConnectionShape,
    "status" | "accessToken" | "workspaceId"
  >,
): boolean {
  return (
    connection.status === "installed" &&
    Boolean(connection.accessToken) &&
    Boolean(connection.workspaceId)
  )
}
