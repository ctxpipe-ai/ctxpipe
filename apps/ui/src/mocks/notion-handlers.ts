import { HttpResponse, http } from "msw"
import type { NotionResource } from "@/features/connectors/types"

/** Notion pages and databases that the story connection can read. */
export const NOTION_STORY_RESOURCES: NotionResource[] = [
  {
    externalId: "1a2b3c4d-0000-4000-8000-000000000001",
    type: "page",
    title: "Engineering handbook",
    url: null,
    parentExternalId: null,
  },
  {
    externalId: "1a2b3c4d-0000-4000-8000-000000000002",
    type: "database",
    title: "Incident log",
    url: null,
    parentExternalId: null,
  },
  {
    externalId: "1a2b3c4d-0000-4000-8000-000000000003",
    type: "page",
    title: "Onboarding",
    url: null,
    parentExternalId: null,
  },
]

/** The Notion search of the scope picker; `q` filters by title. */
export const notionResourcesHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/notion/available-resources",
    ),
  ({ request }) => {
    const q = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? ""
    return HttpResponse.json({
      items: NOTION_STORY_RESOURCES.filter((resource) =>
        resource.title.toLowerCase().includes(q),
      ),
    })
  },
)
