import { eq } from "drizzle-orm"

import type { AppEnv } from "../../../app/env.js"
import type { Env } from "../../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../../db/client.js"
import { CONNECTION_TYPE_GITHUB } from "../../../db/schema/connections.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import {
  listConnectionDirectoryByGithubInstallationId,
  loadConnectionViaDirectory,
} from "../../../models/connection-directory.js"
import { githubRowHasOwnApp } from "../../../models/connection-rows.js"

/**
 * Why a GitHub webhook delivery reached no connection. The handler answers 200
 * for such a delivery, so this reason is the only record of the miss.
 */
type GithubWebhookMissReason = "no_connection" | "own_app" | "other_connection"

const MISS_MESSAGES: Record<GithubWebhookMissReason, string> = {
  no_connection:
    "No connection on this deployment has this GitHub installation. The installation can belong to another environment or to a removed connection.",
  own_app:
    "Each connection with this installation uses its own GitHub App. That App must send its webhooks to /api/v1/webhook/github/<connectionId>.",
  other_connection:
    "This installation belongs to a different connection than the webhook URL names.",
}

async function githubWebhookMissReason(
  installationId: number,
  githubConnectionId: string | undefined,
  env: Env,
): Promise<GithubWebhookMissReason> {
  if (githubConnectionId) return "other_connection"
  const directoryRows =
    await listConnectionDirectoryByGithubInstallationId(installationId)
  const rows = await Promise.all(
    directoryRows.map((row) => loadConnectionViaDirectory(row.connectionId)),
  )
  return rows.some(
    (row) =>
      row?.type === CONNECTION_TYPE_GITHUB && githubRowHasOwnApp(row, env),
  )
    ? "own_app"
    : "no_connection"
}

type WebhookLog = Pick<AppEnv["Variables"]["log"], "info">

type WebhookDelivery = {
  event: string
  installationId: number
  githubConnectionId?: string
}

/** Logs, with no secret, that a delivery matched no organization. */
export async function logGithubWebhookNoOrganization(
  delivery: WebhookDelivery,
  env: Env,
  log: WebhookLog,
): Promise<void> {
  const reason = await githubWebhookMissReason(
    delivery.installationId,
    delivery.githubConnectionId,
    env,
  )
  log.info("github_webhook_no_organization", {
    githubWebhook: {
      event: delivery.event,
      installationId: delivery.installationId,
      connectionId: delivery.githubConnectionId,
      outcome: "no_organization",
      reason,
      message: MISS_MESSAGES[reason],
    },
  })
}

/**
 * Logs, with no secret, that the organizations of a delivery have no
 * Workspace. Their tip checks then have no Workspace to read.
 */
export async function logGithubWebhookNoWorkspace(
  delivery: WebhookDelivery & { orgIds: readonly string[] },
  log: WebhookLog,
): Promise<void> {
  for (const orgId of new Set(delivery.orgIds)) {
    const [row] = await withOrgDbContext(orgId, () =>
      getOrgDb()
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.orgId, orgId))
        .limit(1),
    )
    if (row) return
  }
  log.info("github_webhook_no_workspace", {
    githubWebhook: {
      event: delivery.event,
      installationId: delivery.installationId,
      connectionId: delivery.githubConnectionId,
      outcome: "no_workspace",
      message:
        "The organizations of this installation have no Workspace, so the tip check has nothing to read.",
    },
  })
}
