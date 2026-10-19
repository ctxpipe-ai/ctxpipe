import { HttpResponse, http } from "msw"
import type { PagerdutyService } from "@/features/connectors/queries/pagerduty-connector"

/** The PagerDuty services that the story connection can read. */
const PAGERDUTY_STORY_SERVICES: PagerdutyService[] = [
  { id: "PSVC001", name: "checkout-api" },
  { id: "PSVC002", name: "billing-worker" },
  { id: "PSVC003", name: "search-gateway" },
  { id: "PSVC004", name: "status-page" },
]

/**
 * The PagerDuty service search of the scope picker. `q` filters by name, and
 * a page holds two services, so the picker shows more on request.
 */
export const pagerdutyServicesHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/pagerduty/available-services",
    ),
  ({ request }) => {
    const search = new URL(request.url).searchParams
    const q = search.get("q")?.toLowerCase() ?? ""
    const offset = Number(search.get("offset") ?? 0)
    const matches = PAGERDUTY_STORY_SERVICES.filter((service) =>
      service.name.toLowerCase().includes(q),
    )
    return HttpResponse.json({
      items: matches.slice(offset, offset + 2),
      more: offset + 2 < matches.length,
    })
  },
)
