import { Buffer } from "node:buffer"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { LinearWebhookClient } from "@linear/sdk/webhooks"
import type { AppEnv } from "../../../app/env.js"
import {
  getLinearBindingByConnectionId,
  listLinearConnectionsByWorkspaceId,
  recordLinearOAuthRevocation,
} from "../../../models/linear-connector.js"
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

export function registerLinearWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/linear", async (c) => {
    const env = c.get("env")
    if (!env.LINEAR_WEBHOOK_SECRET) {
      c.get("log").error(new Error("LINEAR_WEBHOOK_SECRET is not configured"))
      return c.json({ error: "Linear webhook is not configured" }, 503)
    }
    const signature = c.req.header("linear-signature")
    if (!signature) {
      return c.json({ error: "Missing Linear signature" }, 401)
    }

    const rawBody = Buffer.from(await c.req.raw.arrayBuffer())
    let bodyTimestamp: number | undefined
    try {
      const unverified = JSON.parse(rawBody.toString("utf8")) as unknown
      if (
        unverified &&
        typeof unverified === "object" &&
        !Array.isArray(unverified) &&
        typeof (unverified as Record<string, unknown>).webhookTimestamp ===
          "number"
      ) {
        bodyTimestamp = (unverified as Record<string, number>).webhookTimestamp
      }
    } catch {
      return c.json({ error: "Invalid Linear webhook payload" }, 400)
    }
    const signedTimestamp = c.req.header("linear-timestamp") ?? bodyTimestamp
    if (signedTimestamp == null) {
      return c.json({ error: "Missing Linear webhook timestamp" }, 401)
    }
    let verified: unknown
    try {
      verified = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET).parseData(
        rawBody,
        signature,
        signedTimestamp,
      )
    } catch (error) {
      c.get("log").warn("linear_webhook_verification_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: "Invalid Linear webhook" }, 401)
    }
    if (!verified || typeof verified !== "object" || Array.isArray(verified)) {
      return c.json({ error: "Invalid Linear webhook payload" }, 400)
    }
    const payload = verified as Record<string, unknown>
    const workspaceId = stringField(payload, "organizationId")
    if (!workspaceId) {
      return c.json({ error: "Missing Linear workspace identifier" }, 400)
    }
    const connections = await listLinearConnectionsByWorkspaceId(
      workspaceId,
      env,
    )
    if (connections.length === 0) return c.body(null, 202)

    if (
      stringField(payload, "type") === "OAuthApp" &&
      stringField(payload, "action") === "revoked"
    ) {
      await Promise.all(
        connections.map((connection) =>
          recordLinearOAuthRevocation({
            connectionId: connection.id,
            env,
            payload,
          }),
        ),
      )
      return c.body(null, 200)
    }

    const target = entityTargetForPayload(payload)
    if (!target) return c.body(null, 202)
    for (const connection of connections) {
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
    return c.body(null, 200)
  })
}

export const linearEntityTargetForPayload = entityTargetForPayload
