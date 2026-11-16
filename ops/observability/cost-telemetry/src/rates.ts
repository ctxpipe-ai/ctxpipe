// The per-seat list prices of the derived rows (README "Sources"). Update a constant when its pricing page changes.

// USD per seat per month, by Linear plan: PaidSubscription.type without its billing suffix (`basic`, `basic_yearly`
// and `basic_monthly` are all `basic`). The pricing page shows only the yearly rates, so a workspace that pays monthly
// pays more than this. A plan that is not here (Enterprise, a legacy plan) fails the provider until its price is added.
// checked 2026-11-16 https://linear.app/pricing
export const linearUsdPerSeatMonth: Record<string, number> = {
  basic: 10,
  business: 16,
}

// USD per seat per month, by GitHub plan name (GET /orgs/{org} plan.name).
// checked 2026-11-16 https://github.com/pricing
export const githubUsdPerSeatMonth: Record<string, number> = {
  team: 4,
}
