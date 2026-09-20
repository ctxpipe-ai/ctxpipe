import { Buffer } from "node:buffer"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { LinearWebhookClient } from "@linear/sdk/webhooks"
import type { AppEnv } from "../../../app/env.js"
import type { Env } from "../../../config/env.js"
import {
  getLinearBindingByConnectionId,
  listLinearConnectionsByWorkspaceId,
  recordLinearOAuthRevocation,
  type LinearConnection,
} from "../../../models/linear-connector.js"
import { getLinearWebhookSecret } from "../../../models/linear-oauth-app.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { linearSyncEntity } from "../../../openworkflow/workflows/linear-sync-entity.js"

type EntityTarget = {
  entityType:
    | "cycle"
    | "customerNeed"
    | "document"
    | "initiative"
    | "issue"
    | "issueLabel"
    | "project"
    | "team"
    | "user"
  externalId: string
  action: "upsert" | "delete"
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

function entityTargetForPayload(
  payload: Record<string, unknown>,
): EntityTarget | undefined {
  const type = stringField(payload, "type")
  const action = stringField(payload, "action")
  const data =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined
  if (!type || !data) return undefined
  const id = stringField(data, "id")
  const rootAction =
    action === "remove" || action === "delete" ? "delete" : "upsert"

  switch (type) {
    case "Attachment": {
      const issueId = stringField(data, "issueId")
      return issueId
        ? { entityType: "issue", externalId: issueId, action: "upsert" }
        : undefined
    }
    case "Comment": {
      const issueId = stringField(data, "issueId")
      if (issueId)
        return { entityType: "issue", externalId: issueId, action: "upsert" }
      const projectId = stringField(data, "projectId")
      if (projectId) {
        return {
          entityType: "project",
          externalId: projectId,
          action: "upsert",
        }
      }
      const initiativeId = stringField(data, "initiativeId")
      return initiativeId
        ? {
            entityType: "initiative",
            externalId: initiativeId,
            action: "upsert",
          }
        : undefined
    }
    case "CustomerNeed": {
      if (rootAction === "delete" && id) {
        return {
          entityType: "customerNeed",
          externalId: id,
          action: "delete",
        }
      }
      const issueId = stringField(data, "issueId")
      if (issueId)
        return { entityType: "issue", externalId: issueId, action: "upsert" }
      const projectId = stringField(data, "projectId")
      return projectId
        ? { entityType: "project", externalId: projectId, action: "upsert" }
        : undefined
    }
    case "InitiativeUpdate": {
      const initiativeId = stringField(data, "initiativeId")
      return initiativeId
        ? {
            entityType: "initiative",
            externalId: initiativeId,
            action: "upsert",
          }
        : undefined
    }
    case "ProjectUpdate": {
      const projectId = stringField(data, "projectId")
      return projectId
        ? { entityType: "project", externalId: projectId, action: "upsert" }
        : undefined
    }
    case "Cycle":
      return id
        ? { entityType: "cycle", externalId: id, action: rootAction }
        : undefined
    case "Document":
      return id
        ? { entityType: "document", externalId: id, action: rootAction }
        : undefined
    case "Initiative":
      return id
        ? { entityType: "initiative", externalId: id, action: rootAction }
        : undefined
    case "Issue":
      return id
        ? { entityType: "issue", externalId: id, action: rootAction }
        : undefined
    case "IssueLabel":
      return id
        ? { entityType: "issueLabel", externalId: id, action: rootAction }
        : undefined
    case "Project":
      return id
        ? { entityType: "project", externalId: id, action: rootAction }
        : undefined
    case "Team":
      return id
        ? { entityType: "team", externalId: id, action: rootAction }
        : undefined
    case "User":
      return id
        ? { entityType: "user", externalId: id, action: rootAction }
        : undefined
    default:
      return undefined
  }
}

function verifyLinearWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: string,
  signedTimestamp: string | number,
): Record<string, unknown> | undefined {
  try {
    const verified = new LinearWebhookClient(secret).parseData(
      rawBody,
      signature,
      signedTimestamp,
    )
    if (!verified || typeof verified !== "object" || Array.isArray(verified)) {
      return undefined
    }
    return verified as Record<string, unknown>
  } catch {
    return undefined
  }
}

function bindLinearWebhookConnections(input: {
  connections: LinearConnection[]
  env: Env
  rawBody: Buffer
  signature: string
  signedTimestamp: string | number
}):
  | { status: "verified"; payload: Record<string, unknown>; connections: LinearConnection[] }
  | { status: "unauthorized" } {
  const envSecret = input.env.LINEAR_WEBHOOK_SECRET
  const matched: LinearConnection[] = []
  let payload: Record<string, unknown> | undefined

  for (const connection of input.connections) {
    if (!connection.webhookSecretEnc) continue
    const rowSecret = getLinearWebhookSecret(connection, {
      ...input.env,
      LINEAR_WEBHOOK_SECRET: undefined,
    })
    if (!rowSecret) continue
    const verified = verifyLinearWebhookSignature(
      rowSecret,
      input.rawBody,
      input.signature,
      input.signedTimestamp,
    )
    if (!verified) continue
    payload = verified
    matched.push(connection)
  }

  if (matched.length > 0 && payload) {
    return { status: "verified", payload, connections: matched }
  }

  if (envSecret) {
    const verified = verifyLinearWebhookSignature(
      envSecret,
      input.rawBody,
      input.signature,
      input.signedTimestamp,
    )
    if (verified) {
      return {
        status: "verified",
        payload: verified,
        connections: input.connections,
      }
    }
  }

  return { status: "unauthorized" }
}

async function processVerifiedLinearWebhook(input: {
  env: Env
  payload: Record<string, unknown>
  connections: LinearConnection[]
}): Promise<void> {
  if (
    stringField(input.payload, "type") === "OAuthApp" &&
    stringField(input.payload, "action") === "revoked"
  ) {
    await Promise.all(
      input.connections.map((connection) =>
        recordLinearOAuthRevocation({
          connectionId: connection.id,
          env: input.env,
          payload: input.payload,
        }),
      ),
    )
    return
  }

  const target = entityTargetForPayload(input.payload)
  if (!target) return
  for (const connection of input.connections) {
    if (connection.status !== "installed") continue
    const binding = await getLinearBindingByConnectionId(connection.id)
    if (!binding?.enabled || binding.setupPhase !== "live") {
      continue
    }
    await runWorkflowWithWorkerWake(linearSyncEntity.spec, {
      orgId: connection.orgId,
      connectionId: connection.id,
      ...target,
    })
  }
}

export function registerLinearWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/linear", async (c) => {
    const env = c.get("env")
    const signature = c.req.header("linear-signature")
    if (!signature) {
      return c.json({ error: "Missing Linear signature" }, 401)
    }

    const rawBody = Buffer.from(await c.req.raw.arrayBuffer())
    let unverified: Record<string, unknown>
    let bodyTimestamp: number | undefined
    try {
      const parsed = JSON.parse(rawBody.toString("utf8")) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "Invalid Linear webhook payload" }, 400)
      }
      unverified = parsed as Record<string, unknown>
      if (typeof unverified.webhookTimestamp === "number") {
        bodyTimestamp = unverified.webhookTimestamp
      }
    } catch {
      return c.json({ error: "Invalid Linear webhook payload" }, 400)
    }
    const signedTimestamp = c.req.header("linear-timestamp") ?? bodyTimestamp
    if (signedTimestamp == null) {
      return c.json({ error: "Missing Linear webhook timestamp" }, 401)
    }

    const workspaceId = stringField(unverified, "organizationId")
    if (!workspaceId) {
      return c.json({ error: "Missing Linear workspace identifier" }, 400)
    }

    const connections = await listLinearConnectionsByWorkspaceId(
      workspaceId,
      env,
    )
    const hasRowSecret = connections.some((connection) =>
      Boolean(connection.webhookSecretEnc),
    )
    if (!env.LINEAR_WEBHOOK_SECRET && !hasRowSecret) {
      c.get("log").error(new Error("LINEAR_WEBHOOK_SECRET is not configured"))
      return c.json({ error: "Linear webhook is not configured" }, 503)
    }

    const bound = bindLinearWebhookConnections({
      connections,
      env,
      rawBody,
      signature,
      signedTimestamp,
    })
    if (bound.status === "unauthorized") {
      c.get("log").warn("linear_webhook_verification_failed")
      return c.json({ error: "Invalid Linear webhook" }, 401)
    }

    await processVerifiedLinearWebhook({
      env,
      payload: bound.payload,
      connections: bound.connections,
    })
    return c.body(null, connections.length === 0 ? 202 : 200)
  })
}

export const linearEntityTargetForPayload = entityTargetForPayload
export const bindLinearWebhookConnectionsForTest = bindLinearWebhookConnections
