import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import type { AppEnv } from "../../app/env.js"
import { recordApiKeyEvent } from "../../auth/api-key-events.js"
import {
  listPersonalApiKeyOrganizations,
  setPersonalApiKeyOrganizations,
} from "../../auth/personal-api-key-organizations.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("PersonalApiKeyErrorResponse")

const errorResponse = (description: string) => ({
  content: { "application/json": { schema: ErrorResponseSchema } },
  description,
})

const listRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              keys: z.array(
                z.object({
                  id: z.string(),
                  organizations: z
                    .array(
                      z.object({
                        id: z.string(),
                        slug: z.string(),
                        name: z.string(),
                      }),
                    )
                    .nullable()
                    .openapi({
                      description:
                        "Null for a key with no org set: it acts on every membership of the user.",
                    }),
                }),
              ),
            })
            .openapi("PersonalApiKeyOrganizationsList"),
        },
      },
      description: "The org set of each personal API key of the user",
    },
    401: errorResponse("No credential"),
    403: errorResponse("Not a signed-in user session"),
  },
})

const setRoute = createRoute({
  method: "put",
  path: "/{keyId}/organizations",
  request: {
    params: z.object({
      keyId: z
        .string()
        .min(1)
        .openapi({ param: { name: "keyId", in: "path" } }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ organizationIds: z.array(z.string().min(1)).min(1) })
            .openapi("PersonalApiKeyOrganizationsBody"),
        },
      },
      required: true,
    },
  },
  responses: {
    204: { description: "The key has the new org set" },
    400: errorResponse("An empty set, or an org the user is not a member of"),
    401: errorResponse("No credential"),
    403: errorResponse("Not a signed-in user session"),
    404: errorResponse("No such personal API key for this user"),
  },
})

/** The user who manages the keys through a browser session. */
function sessionUserId(c: Context<AppEnv>): string | null {
  if (!c.get("session") || c.get("personalApiKeyId")) return null
  return c.get("user")?.id ?? null
}

const NOT_SESSION = "Sign in to manage API keys"

/** `/api/v1/me/api-keys`: the org sets of personal API keys (ADR-051). */
export const meApiKeysRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const userId = sessionUserId(c)
    if (!userId) {
      recordApiKeyEvent({
        step: "api_key.organizations.list",
        outcome: "not_session",
        apiKey: {},
      })
      return c.json({ error: NOT_SESSION }, 403)
    }
    const keys = await listPersonalApiKeyOrganizations(userId)
    recordApiKeyEvent({
      step: "api_key.organizations.list",
      outcome: "success",
      actorId: userId,
      apiKey: { count: keys.length },
    })
    return c.json({ keys }, 200)
  })
  .openapi(setRoute, async (c) => {
    const userId = sessionUserId(c)
    const { keyId } = c.req.valid("param")
    const { organizationIds } = c.req.valid("json")
    const record = (outcome: string) =>
      recordApiKeyEvent({
        step: "api_key.organizations.set",
        outcome,
        actorId: userId,
        apiKey: {
          id: keyId,
          read_only: true,
          organization_count: new Set(organizationIds).size,
        },
      })
    if (!userId) {
      record("not_session")
      return c.json({ error: NOT_SESSION }, 403)
    }
    const result = await setPersonalApiKeyOrganizations({
      userId,
      keyId,
      organizationIds,
    })
    record(result === "ok" ? "success" : result)
    if (result === "not_found")
      return c.json({ error: "API key not found" }, 404)
    if (result === "empty")
      return c.json(
        { error: "Select at least one organization for this key" },
        400,
      )
    if (result === "not_member")
      return c.json(
        { error: "You can select only organizations that you are a member of" },
        400,
      )
    return c.body(null, 204)
  })
