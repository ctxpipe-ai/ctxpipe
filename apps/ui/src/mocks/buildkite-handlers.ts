import { HttpResponse, http } from "msw"
import type {
  BuildkiteConnectorStatus,
  BuildkitePipeline,
} from "@/features/connectors/queries/buildkite-connector"

/** The pipelines that the story connection can read. */
export const BUILDKITE_STORY_PIPELINES: BuildkitePipeline[] = [
  { slug: "web-app", name: "Web App" },
  { slug: "api", name: "API" },
  { slug: "deploy-production", name: "Deploy production" },
]

export const buildkiteStoryStatus = (
  overrides: Partial<BuildkiteConnectorStatus> = {},
): BuildkiteConnectorStatus => ({
  status: "installed",
  organizationSlug: "acme",
  webhookUrl:
    "https://app.example.com/api/v1/webhook/buildkite/con_story_buildkite",
  webhookConfigured: false,
  ...overrides,
})

export function buildkiteStatusHandler(status: BuildkiteConnectorStatus) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith(
        "/api/v1/connectors/buildkite/status",
      ),
    () => HttpResponse.json(status),
  )
}

/** The pipeline list of the scope picker: one response for the organization. */
export const buildkitePipelinesHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/buildkite/pipelines",
    ),
  () =>
    HttpResponse.json({ items: BUILDKITE_STORY_PIPELINES, truncated: false }),
)
