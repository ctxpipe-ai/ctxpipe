import { eq } from "drizzle-orm"
import { App, Octokit } from "octokit"

import type { Env } from "../config/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { connectionDirectory, connections } from "../db/schema/connections.js"
import { normalisePrivateKey } from "../models/github-installation.js"
import {
  decryptConnectionSecret,
  isConnectionSecretCiphertext,
} from "./connection-secrets.js"
import { type CheckResult, check } from "./validate-target.js"

/*
 * The secret checks of a deployed ctxpipe (CTX-1217). They run inside the
 * target, with its environment and its database, as the backend's one-off
 * task. The HTTP checks of `validateTarget` cannot see a wrong secret: with
 * the wrong connection-secret key or the wrong GitHub App key, the status, the
 * sign-in and the MCP read still pass, and only the connector jobs fail.
 *
 * The result holds counts and the App ID only: no secret, no organization id.
 * A database error names its query parameters, so the check reports only the
 * count of organizations that it could not read.
 */

export async function validateTargetSecrets(env: Env): Promise<CheckResult[]> {
  return [
    await check("connection secrets decrypt", () =>
      checkConnectionSecrets(env),
    ),
    await check("github installation token", () => checkGithubApp(env)),
  ]
}

/**
 * Decrypts each stored connection secret with the target's key. A wrong
 * CONNECTION_SECRETS_ENCRYPTION_KEY (or, without it, a wrong AUTH_SECRET)
 * fails each one with an AES-GCM authentication error.
 */
async function checkConnectionSecrets(env: Env): Promise<string> {
  const orgIds = await getSystemDb()
    .selectDistinct({ orgId: connectionDirectory.orgId })
    .from(connectionDirectory)
  let decrypted = 0
  let failed = 0
  let unread = 0
  for (const { orgId } of orgIds) {
    const rows = await withOrgDbContext(orgId, (db) =>
      db
        .select({ config: connections.config })
        .from(connections)
        .where(eq(connections.orgId, orgId)),
    ).catch(() => null)
    if (!rows) {
      unread += 1
      continue
    }
    for (const ciphertext of rows.flatMap(({ config }) => stored(config))) {
      try {
        decryptConnectionSecret(ciphertext, env)
        decrypted += 1
      } catch {
        failed += 1
      }
    }
  }
  if (unread > 0)
    throw new Error(
      `The connections of ${unread} organizations could not be read. Run the check again.`,
    )
  if (failed > 0)
    throw new Error(
      `${failed} of ${decrypted + failed} stored secrets do not decrypt with this key. Copy CONNECTION_SECRETS_ENCRYPTION_KEY and AUTH_SECRET from production.`,
    )
  if (decrypted === 0)
    throw new Error("No stored connection secret: nothing to decrypt.")
  return `${decrypted} stored secrets decrypt`
}

/** The encrypted values in a `connections.config`, at any depth. */
function stored(value: unknown): string[] {
  if (isConnectionSecretCiphertext(value)) return [value]
  if (Array.isArray(value)) return value.flatMap(stored)
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(stored)
  return []
}

/**
 * Mints an installation token with GITHUB_APP_ID and GITHUB_PRIVATE_KEY, then
 * revokes it. A key of another App fails the JWT, and GitHub answers 401.
 */
async function checkGithubApp(env: Env): Promise<string> {
  const appId = env.GITHUB_APP_ID
  const privateKey = normalisePrivateKey(env.GITHUB_PRIVATE_KEY ?? "")
  if (!appId || !privateKey)
    throw new Error("GITHUB_APP_ID or GITHUB_PRIVATE_KEY is not set.")
  const app = new App({ appId, privateKey })
  // GitHub refuses a token for a suspended installation.
  const { data } = await app.octokit.rest.apps.listInstallations({
    per_page: 100,
  })
  const installation = data.find(({ suspended_at }) => !suspended_at)
  if (!installation)
    throw new Error("The GitHub App has no installation that is not suspended.")
  const {
    data: { token },
  } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installation.id,
    permissions: { metadata: "read" },
  })
  await new Octokit({ auth: token }).rest.apps.revokeInstallationAccessToken()
  return `App ${appId}: an installation token was minted and revoked`
}
