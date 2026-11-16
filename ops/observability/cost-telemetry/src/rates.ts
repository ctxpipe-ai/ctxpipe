// The per-seat list prices of the derived rows (README "Sources"). Update a constant when its pricing page changes.

// USD per seat per month, by Linear's subscription type (PaidSubscription.type, `<plan>_<billing>`). The pricing page
// shows only the yearly rates; a type that is not here (a monthly or an Enterprise subscription) fails the provider
// until its price is added.
// checked 2026-11-16 https://linear.app/pricing
export const linearUsdPerSeatMonth: Record<string, number> = {
  basic_yearly: 10,
  business_yearly: 16,
}

// USD per seat per month, by GitHub plan name (GET /orgs/{org} plan.name). The free plan has no seat price.
// checked 2026-11-16 https://github.com/pricing
export const githubUsdPerSeatMonth: Record<string, number> = {
  free: 0,
  team: 4,
}
