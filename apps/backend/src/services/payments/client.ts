import { TransientHttpError, withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import type { Env } from "../../config/env.js"
import { BillingEntitlementSchema, type BillingEntitlement } from "./types.js"

export class BillingHardBlockedError extends Error {
  constructor(public readonly reason: string | null) {
    super(reason ? `Billing hard-blocked: ${reason}` : "Billing hard-blocked")
    this.name = "BillingHardBlockedError"
  }
}

export function isManagedBillingEnabled(env: Env): boolean {
  return Boolean(env.PAYMENTS_SERVICE_URL && env.PAYMENTS_SERVICE_AUTH_TOKEN)
}

function baseHeaders(env: Env, requestId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${env.PAYMENTS_SERVICE_AUTH_TOKEN ?? ""}`,
    "X-Request-Id": requestId,
    "Content-Type": "application/json",
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`
}

export async function getOrgEntitlement(input: {
  env: Env
  orgId: string
  requestId: string
}): Promise<BillingEntitlement | null> {
  if (!isManagedBillingEnabled(input.env)) {
    return null
  }
  const run = async () => {
    const res = await fetch(
      endpoint(input.env.PAYMENTS_SERVICE_URL!, `/internal/entitlements/${encodeURIComponent(input.orgId)}`),
      { method: "GET", headers: baseHeaders(input.env, input.requestId) },
    )
    if ([502, 503, 504].includes(res.status)) {
      throw new TransientHttpError(`payments entitlements transient ${res.status}`, res.status)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Payments auth rejected internal entitlement request")
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Payments entitlement request failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as { entitlement?: unknown }
    return BillingEntitlementSchema.parse(body.entitlement)
  }
  return withTransientHttpRetry(run)
}

export async function getCheckoutEligibility(input: {
  env: Env
  orgId: string
  requestId: string
}): Promise<{ allowed: boolean; code?: string }> {
  if (!isManagedBillingEnabled(input.env)) {
    return { allowed: true }
  }
  const run = async () => {
    const res = await fetch(
      endpoint(
        input.env.PAYMENTS_SERVICE_URL!,
        `/internal/checkout-eligibility/${encodeURIComponent(input.orgId)}`,
      ),
      { method: "GET", headers: baseHeaders(input.env, input.requestId) },
    )
    if ([502, 503, 504].includes(res.status)) {
      throw new TransientHttpError(`payments eligibility transient ${res.status}`, res.status)
    }
    if (res.status === 503) {
      return { allowed: false, code: "dependency_unavailable" }
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Payments eligibility request failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as { allowed?: boolean; error?: { code?: string } }
    return { allowed: body.allowed === true, code: body.error?.code }
  }
  return withTransientHttpRetry(run)
}
