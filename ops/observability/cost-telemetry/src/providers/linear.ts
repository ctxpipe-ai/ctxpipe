import { getJson, isRecord, requiredEnv, throwGraphqlErrors } from "../http"
import { linearUsdPerSeatMonth } from "../rates"
import { seatRows, type CostRow } from "../rows"

/**
 * Linear has no cost API. The workspace's paid subscription (Organization.subscription, a PaidSubscription in
 * https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) gives the plan and the seats; the
 * rows are the billed seats × the committed seat price of the subscription type (src/rates.ts), source `derived`;
 * sku is the subscription type. The billed seats are
 * `seats` clamped to `seatsMinimum` and `seatsMaximum`. A workspace with no paid subscription gives no rows.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const key = requiredEnv("LINEAR_API_KEY")
  const body = await getJson(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { organization { subscription { type seats seatsMinimum seatsMaximum } } }" }),
    },
    "Linear",
  )
  if (!isRecord(body)) throw new Error("Linear response was missing data")
  throwGraphqlErrors(body, "Linear")
  const organization = isRecord(body.data) && isRecord(body.data.organization) ? body.data.organization : undefined
  if (!organization) throw new Error("Linear response was missing organization")
  const subscription = organization.subscription
  if (subscription === null) return []
  if (!isRecord(subscription) || typeof subscription.type !== "string") throw new Error("Linear response was missing subscription.type")
  if (typeof subscription.seats !== "number" || !Number.isFinite(subscription.seats)) {
    throw new Error("Linear response was missing subscription.seats")
  }
  // A price suffix (`basic_monthly_12`) goes. An older schema names only the plan (`basic`): it takes the yearly rate.
  const variant = subscription.type.replace(/_\d+$/, "")
  const price = linearUsdPerSeatMonth[variant] ?? linearUsdPerSeatMonth[`${variant}_yearly`]
  if (price === undefined) throw new Error(`no committed seat price for Linear subscription type ${subscription.type} (src/rates.ts)`)
  let seats = subscription.seats
  if (typeof subscription.seatsMinimum === "number") seats = Math.max(seats, subscription.seatsMinimum)
  if (typeof subscription.seatsMaximum === "number") seats = Math.min(seats, subscription.seatsMaximum)
  return seatRows(days, { provider: "linear", sku: subscription.type, scope: "workspace" }, seats, price)
}
