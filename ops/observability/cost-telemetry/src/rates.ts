// The per-seat list prices of the derived rows (README "Sources"). Update a constant when its pricing page changes.

// USD per seat per month, by Linear subscription type (PaidSubscription.type, `<plan>_<billing>`). The pricing page's
// "Billed yearly" toggle switches between the subscriptions basic_yearly_10 and basic_monthly_12, and
// business_yearly_16 and business_monthly_18. A type that is not here (Enterprise, a legacy plan) fails the provider
// until its price is added.
// checked 2026-11-16 https://linear.app/pricing
export const linearUsdPerSeatMonth: Record<string, number> = {
  basic_yearly: 10,
  basic_monthly: 12,
  business_yearly: 16,
  business_monthly: 18,
}

// USD per seat per month, by GitHub plan name (GET /orgs/{org} plan.name).
// checked 2026-11-16 https://github.com/pricing
export const githubUsdPerSeatMonth: Record<string, number> = {
  team: 4,
}
