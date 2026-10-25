import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { eq } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { apikeys } from "../db/schema/auth.js"
import {
  applyAttribution,
  sanitizeAttribution,
} from "../observability/attribution.js"
import { getLogger, log } from "../observability/logger.js"
import { PERSONAL_API_KEY_ORGANIZATIONS_HEADER } from "./personal-api-key-organizations.js"

const STEPS: Record<string, string> = {
  "/api-key/create": "api_key.create",
  "/api-key/update": "api_key.update",
  "/api-key/delete": "api_key.delete",
}

/**
 * One wide event for one API key action: the step, the outcome, the key id,
 * who did it, and the facts of the key. The step, the outcome, and a refusal
 * reason go on the server span and on the log through the attribution
 * allowlist. The key facts are flat `api_key.*` log keys, as in other wide
 * events. It never holds the key value or its prefix. A caller outside a
 * request has no request logger, and the event is then a log line of its own.
 */
export function recordApiKeyEvent(event: {
  step: string
  outcome: string
  /** Why the key was refused, for a refusal. */
  reason?: string
  actorId?: string | null
  /** The org of an organization key. */
  orgId?: string
  apiKey: Record<string, string | number | boolean | undefined>
}): void {
  const attribution = {
    "ctxpipe.api_key.event": event.step,
    "ctxpipe.api_key.outcome": event.outcome,
    "ctxpipe.auth.refusal_reason": event.reason,
    "ctxpipe.org.id": event.orgId,
    "enduser.id": event.actorId ?? undefined,
    "ctxpipe.actor.type": event.actorId ? "user" : undefined,
  }
  const fields = Object.fromEntries(
    Object.entries(event.apiKey)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [`api_key.${name}`, value]),
  )
  const failed = event.outcome !== "success"
  let logger: ReturnType<typeof getLogger> | undefined
  try {
    logger = getLogger()
  } catch {
    // No request logger: a script, or a server-side call.
  }
  if (!logger) {
    log[failed ? "warn" : "info"]({
      ...sanitizeAttribution(attribution),
      ...fields,
    })
    return
  }
  applyAttribution(attribution)
  if (failed) logger.warn(`${event.step} did not succeed`, fields)
  else logger.set(fields)
}

/**
 * The org of a key that is about to be deleted. The delete answer and the
 * deleted row hold no org, so the before hook reads it from the row. The key
 * of this map is the Better Auth call context. Each call has its own, and the
 * before and the after hook of that call both see it. Two calls for the same
 * key therefore never share an entry, and the entry goes away with the call,
 * also when the endpoint throws an error that is not an APIError.
 */
const deletedKeyOrgs = new WeakMap<object, string>()

function organizationCount(header: string | null | undefined) {
  if (header == null) return undefined
  return new Set(
    header
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).size
}

/**
 * Better Auth hooks for the API key create, update and delete endpoints
 * (CTX-881). The after hook runs after the hook that writes the org set, so a
 * create that this hook refused shows as a failure. The before hook of a
 * delete reads the org of the key from its row, because the delete removes it.
 */
export function apiKeyLifecycleEvents(): BetterAuthPlugin {
  return {
    id: "api-key-lifecycle-events",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/api-key/delete",
          handler: createAuthMiddleware(async (ctx) => {
            try {
              const keyId = (ctx.body as Record<string, unknown> | undefined)
                ?.keyId
              if (typeof keyId !== "string") return
              const [row] = await getSystemDb()
                .select({
                  configId: apikeys.configId,
                  referenceId: apikeys.referenceId,
                })
                .from(apikeys)
                .where(eq(apikeys.id, keyId))
                .limit(1)
              if (row && row.configId !== "default") {
                deletedKeyOrgs.set(ctx.context, row.referenceId)
              }
            } catch {
              // The event goes without an org; the delete goes on.
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) => Boolean(context.path && STEPS[context.path]),
          handler: createAuthMiddleware(async (ctx) => {
            const step = STEPS[ctx.path]
            if (!step) return
            // An observer error must not turn a created key into a 500.
            try {
              const body = (ctx.body ?? {}) as Record<string, unknown>
              const returned = ctx.context.returned
              const failed = returned instanceof Error
              const result =
                !failed && returned && typeof returned === "object"
                  ? (returned as Record<string, unknown>)
                  : {}
              const keyId =
                typeof result.id === "string"
                  ? result.id
                  : typeof body.keyId === "string"
                    ? body.keyId
                    : undefined
              const configId =
                typeof result.configId === "string"
                  ? result.configId
                  : typeof body.configId === "string"
                    ? body.configId
                    : step === "api_key.create"
                      ? "default"
                      : undefined
              const personal =
                configId === undefined ? undefined : configId === "default"
              // The org of a delete comes from the row, read before the
              // delete, and never from the request body. The org of a create
              // or update is the caller's `organizationId` only when the call
              // succeeded, which means that Better Auth checked it. A refused
              // call keeps it as a requested id and never as the org of the
              // event. A refused delete records the org of the row as the
              // target org only.
              const rowOrg =
                step === "api_key.delete"
                  ? deletedKeyOrgs.get(ctx.context)
                  : undefined
              const requestedOrg =
                typeof body.organizationId === "string"
                  ? body.organizationId
                  : undefined
              const orgId =
                failed || personal !== false
                  ? undefined
                  : step === "api_key.delete"
                    ? rowOrg
                    : [result.referenceId, requestedOrg].find(
                        (value): value is string => typeof value === "string",
                      )
              recordApiKeyEvent({
                step,
                outcome: failed ? "failure" : "success",
                actorId: ctx.context.session?.user.id,
                orgId,
                apiKey: {
                  id: keyId,
                  requested_org_id:
                    failed && personal === false ? requestedOrg : undefined,
                  target_org_id: failed ? rowOrg : undefined,
                  owner:
                    personal === undefined
                      ? undefined
                      : personal
                        ? "personal"
                        : "organization",
                  read_only: personal,
                  organization_count:
                    step === "api_key.create" && personal
                      ? organizationCount(
                          ctx.headers?.get(
                            PERSONAL_API_KEY_ORGANIZATIONS_HEADER,
                          ),
                        )
                      : undefined,
                },
              })
            } catch (error) {
              log.warn({
                step: "api_key.event_failed",
                error: error instanceof Error ? error.message : "unknown",
              })
            }
          }),
        },
      ],
    },
  }
}
