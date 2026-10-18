import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
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
  apiKey: Record<string, string | number | boolean | undefined>
}): void {
  const attribution = {
    "ctxpipe.api_key.event": event.step,
    "ctxpipe.api_key.outcome": event.outcome,
    "ctxpipe.auth.refusal_reason": event.reason,
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
 * Better Auth after-hook for the API key create, update and delete
 * endpoints (CTX-881). It runs after the hook that writes the org set, so a
 * create that this hook refused shows as a failure, and the id of the key
 * that it deleted is not on the event.
 */
export function apiKeyLifecycleEvents(): BetterAuthPlugin {
  return {
    id: "api-key-lifecycle-events",
    hooks: {
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
              recordApiKeyEvent({
                step,
                outcome: failed ? "failure" : "success",
                actorId: ctx.context.session?.user.id,
                apiKey: {
                  id: keyId,
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
