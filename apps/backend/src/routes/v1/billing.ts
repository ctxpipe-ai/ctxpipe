import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { CheckoutUnavailableError, startManagedCheckout } from "../../domain/billing/checkout.js"
import { BillingHardBlockedError, getOrgEntitlement } from "../../services/payments/client.js"

const BillingStatusSchema = z
  .object({
    managedBillingEnabled: z.boolean(),
    entitlement: z
      .object({
        status: z.string(),
        tier: z.string(),
        isHardBlocked: z.boolean(),
        blockingReason: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("BillingStatusResponse")

const CheckoutRequestSchema = z
  .object({
    returnUrl: z.string().url().optional(),
  })
  .openapi("CheckoutRequest")

const CheckoutResponseSchema = z
  .object({
    checkoutUrl: z.string().url(),
  })
  .openapi("CheckoutResponse")

const ErrorResponseSchema = z.object({ error: z.string() }).openapi("BillingErrorResponse")

const getBillingStatusRoute = createRoute({
  method: "get",
  path: "/status",
  responses: {
    200: {
      content: { "application/json": { schema: BillingStatusSchema } },
      description: "Current billing/entitlement status for org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const startCheckoutRoute = createRoute({
  method: "post",
  path: "/checkout",
  request: {
    body: {
      content: {
        "application/json": { schema: CheckoutRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CheckoutResponseSchema } },
      description: "Managed checkout URL ready",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    402: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Billing hard blocked",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Checkout dependency unavailable",
    },
  },
})

export const billingRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getBillingStatusRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    const orgId = c.get("orgId")
    if (!user || !session || !orgId) return c.json({ error: "Unauthorized" }, 401)

    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID()
    const entitlement = await getOrgEntitlement({
      env: c.get("env"),
      orgId,
      requestId,
    })
    return c.json(
      {
        managedBillingEnabled: Boolean(c.get("env").PAYMENTS_SERVICE_URL && c.get("env").PAYMENTS_SERVICE_AUTH_TOKEN),
        entitlement: entitlement
          ? {
              status: entitlement.status,
              tier: entitlement.plan.tier,
              isHardBlocked: entitlement.enforcement.isHardBlocked,
              blockingReason: entitlement.enforcement.blockingReason,
            }
          : null,
      },
      200,
    )
  })
  .openapi(startCheckoutRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    const orgId = c.get("orgId")
    const orgSlug = c.get("orgSlug")
    if (!user || !session || !orgId || !orgSlug) return c.json({ error: "Unauthorized" }, 401)

    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID()
    const body = c.req.valid("json")
    try {
      const result = await startManagedCheckout({
        env: c.get("env"),
        orgId,
        orgSlug,
        requestId,
        returnUrl: body.returnUrl,
      })
      return c.json(result, 200)
    } catch (error) {
      if (error instanceof BillingHardBlockedError) {
        return c.json({ error: error.reason ?? "billing_hard_blocked" }, 402)
      }
      if (error instanceof CheckoutUnavailableError) {
        return c.json({ error: error.code }, 503)
      }
      c.get("log").error(error instanceof Error ? error : new Error(String(error)), {
        step: "billing.checkout",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
