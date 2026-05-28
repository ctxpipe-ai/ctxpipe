import type { Env } from "../../config/env.js"
import {
  BillingHardBlockedError,
  getCheckoutEligibility,
  isManagedBillingEnabled,
} from "../../services/payments/client.js"

export class CheckoutUnavailableError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = "CheckoutUnavailableError"
  }
}

function assertOrgIdInvariant(orgId: string): void {
  if (!orgId.startsWith("org_")) {
    throw new Error("orgId invariant violation: expected org_ prefix")
  }
}

export async function startManagedCheckout(input: {
  env: Env
  orgId: string
  orgSlug: string
  requestId: string
  returnUrl?: string
}): Promise<{ checkoutUrl: string }> {
  assertOrgIdInvariant(input.orgId)
  if (!isManagedBillingEnabled(input.env)) {
    throw new CheckoutUnavailableError("managed_billing_not_configured")
  }
  const eligibility = await getCheckoutEligibility({
    env: input.env,
    orgId: input.orgId,
    requestId: input.requestId,
  })
  if (!eligibility.allowed) {
    throw new BillingHardBlockedError(eligibility.code ?? "checkout_not_allowed")
  }
  const template = input.env.PAYMENTS_CHECKOUT_URL_TEMPLATE
  if (!template || !template.includes("{orgId}")) {
    throw new CheckoutUnavailableError("checkout_template_missing_orgId_placeholder")
  }

  const checkoutUrl = template
    .replaceAll("{orgId}", encodeURIComponent(input.orgId))
    .replaceAll("{orgSlug}", encodeURIComponent(input.orgSlug))
    .replaceAll(
      "{returnUrl}",
      encodeURIComponent(input.returnUrl ?? `${input.env.UI_PROXY_URL}/${input.orgSlug}/organization/billing`),
    )
  return { checkoutUrl }
}
