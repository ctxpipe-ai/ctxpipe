import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import {
  CONNECTION_TYPE_GITHUB,
  connections,
} from "../db/schema/connections.js"
import {
  encodeGithubAppSecretsForDb,
  parseGithubConnectionStored,
  serialiseGithubConnectionConfigForDb,
} from "../lib/connection-config.js"
import { log } from "../observability/logger.js"

const HOSTED_FALLBACK_APP_SLUG = "ctxpipe-agent"

/** One-time migration: copy global GitHub App env into each legacy github `connections` row. */
export async function backfillGithubAppSecretsFromEnv(env: Env): Promise<void> {
  const appId = env.GITHUB_APP_ID?.trim()
  const keyRaw = env.GITHUB_PRIVATE_KEY?.trim()
  const webhook = env.GITHUB_WEBHOOK_SECRET?.trim()
  const appSlug =
    env.GITHUB_APP_SLUG?.trim() || HOSTED_FALLBACK_APP_SLUG

  if (!appId || !keyRaw || !webhook) {
    log.info({
      step: "backfill.github_connection_secrets",
      message: "skip: GITHUB_APP_ID, GITHUB_PRIVATE_KEY, or GITHUB_WEBHOOK_SECRET not all set",
    })
    return
  }

  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`(${connections.config}->>'privateKeyEnc') is null`,
        sql`(${connections.config}->>'installationId') is not null`,
      ),
    )

  let updated = 0
  for (const row of rows) {
    const stored = parseGithubConnectionStored(
      row.config as Record<string, unknown>,
    )
    const enc = encodeGithubAppSecretsForDb(
      {
        githubAppId: appId,
        appSlug,
        privateKey: keyRaw.includes("\\n") ? keyRaw.replace(/\\n/g, "\n") : keyRaw,
        webhookSecret: webhook,
      },
      env,
    )
    const merged = serialiseGithubConnectionConfigForDb({
      ...stored,
      ...enc,
    })
    await db
      .update(connections)
      .set({ config: merged, updatedAt: new Date() })
      .where(eq(connections.id, row.id))
    updated += 1
  }

  if (updated > 0) {
    log.info({
      step: "backfill.github_connection_secrets",
      message: `backfilled encrypted GitHub App credentials on ${updated} connection(s)`,
    })
  }
}
