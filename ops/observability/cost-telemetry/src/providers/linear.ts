import { getJson, isRecord, ProviderError, throwGraphqlErrors } from "../http"
import { linearUsdPerSeatMonth } from "../rates"
import { seatRows, type CostRow } from "../rows"
import { providerInput } from "../secrets"

/**
 * Linear has no cost API. The workspace's paid subscription (Organization.subscription, a PaidSubscription in
 * https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) gives the plan and the seats; the
 * rows are the billed seats × the committed seat price of the subscription type (src/rates.ts), source `derived`;
 * sku is the subscription type. The billed seats are
 * `seats` clamped to `seatsMinimum` and `seatsMaximum`. A workspace with no paid subscription gives no rows.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const token = await appToken()
  const body = await getJson(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          "query { organization { subscription { type seats seatsMinimum seatsMaximum } } }",
      }),
    },
    "Linear",
  )
  if (!isRecord(body))
    throw new ProviderError("parse", "Linear response was missing data")
  throwGraphqlErrors(body, "Linear")
  const organization =
    isRecord(body.data) && isRecord(body.data.organization)
      ? body.data.organization
      : undefined
  if (!organization)
    throw new ProviderError("parse", "Linear response was missing organization")
  const subscription = organization.subscription
  if (subscription === null) return []
  if (!isRecord(subscription) || typeof subscription.type !== "string")
    throw new ProviderError(
      "parse",
      "Linear response was missing subscription.type",
    )
  if (
    typeof subscription.seats !== "number" ||
    !Number.isFinite(subscription.seats)
  ) {
    throw new ProviderError(
      "parse",
      "Linear response was missing subscription.seats",
    )
  }
  // The price suffix of a type (`basic_monthly_12`) goes.
  const price = linearUsdPerSeatMonth[subscription.type.replace(/_\d+$/, "")]
  if (price === undefined)
    throw new ProviderError(
      "no_price",
      `no committed seat price for Linear subscription type ${subscription.type} (src/rates.ts)`,
    )
  let seats = subscription.seats
  if (typeof subscription.seatsMinimum === "number")
    seats = Math.max(seats, subscription.seatsMinimum)
  if (typeof subscription.seatsMaximum === "number")
    seats = Math.min(seats, subscription.seatsMaximum)
  return seatRows(
    days,
    { provider: "linear", sku: subscription.type, scope: "workspace" },
    seats,
    price,
  )
}

/**
 * A token of the `factory` Linear OAuth app, from its client credentials grant
 * (https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens). The app is the identity of the
 * agent hosts too, so the job needs no API key of a person. The scopes must be the same on each token request:
 * Linear revokes all tokens of the app when a request asks for other scopes (factory
 * machines/paseo-hub/agent-hosts/linear-headers.sh uses the same set).
 */
async function appToken(): Promise<string> {
  const clientId = providerInput("LINEAR_CLIENT_ID")
  const clientSecret = providerInput("LINEAR_CLIENT_SECRET")
  const body = await getJson(
    "https://api.linear.app/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope:
          "read,write,issues:create,comments:create,app:assignable,app:mentionable",
      }),
    },
    "Linear token",
  )
  if (!isRecord(body) || typeof body.access_token !== "string")
    throw new ProviderError(
      "parse",
      "Linear token response was missing access_token",
    )
  return body.access_token
}
