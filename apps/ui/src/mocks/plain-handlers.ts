import { HttpResponse, http } from "msw"
import type {
  PlainCatalogItem,
  PlainConnectorStatus,
} from "@/features/connectors/queries/plain-connector"

/** The Help Centers and labels that the story connection can read. */
const PLAIN_STORY_CATALOG: {
  helpCenters: PlainCatalogItem[]
  labels: PlainCatalogItem[]
} = {
  helpCenters: [
    { id: "hc_docs", name: "Product docs" },
    { id: "hc_internal", name: "Internal runbooks" },
  ],
  labels: [
    { id: "lt_bug", name: "Bug" },
    { id: "lt_feature", name: "Feature request" },
  ],
}

export const plainStoryStatus = (
  overrides: Partial<PlainConnectorStatus> = {},
): PlainConnectorStatus => ({
  status: "installed",
  workspaceName: "Acme Support",
  webhookConfigured: true,
  ...overrides,
})

export function plainStatusHandler(status: PlainConnectorStatus) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith("/api/v1/connectors/plain/status"),
    () => HttpResponse.json(status),
  )
}

export const plainCatalogHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith("/api/v1/connectors/plain/catalog"),
  () => HttpResponse.json(PLAIN_STORY_CATALOG),
)
