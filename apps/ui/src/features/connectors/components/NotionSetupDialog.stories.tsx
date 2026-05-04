import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { NotionSetupDialog } from "./NotionSetupDialog"

const orgSlug = "acme"
const connectionId = "story_notion_conn"

const meta = {
  title: "Components/Connections/NotionSetupDialog",
  component: NotionSetupDialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof NotionSetupDialog>

export default meta

type Story = StoryObj<typeof meta>

export const ResourceSelection: Story = {
  render: () => (
    <NotionSetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: true,
                installationStatus: "installed",
                workspaceName: "Acme",
                isGithubLinked: true,
                selectedResourceCount: 0,
                syncTargetConfigured: true,
                setupPhase: "live",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: {
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                },
                selectedResources: [],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/config",
              ),
            () =>
              HttpResponse.json({
                resources: [],
                syncTarget: {
                  id: "nst_1",
                  orgId: "org_1",
                  connectionId,
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                  enabled: true,
                  setupPhase: "live",
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                  createdAt: "2025-01-01T00:00:00.000Z",
                  updatedAt: "2025-01-01T00:00:00.000Z",
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/available-resources",
              ),
            () =>
              HttpResponse.json({
                items: [
                  {
                    externalId: "page_1",
                    type: "page",
                    title: "Product decisions",
                    url: "https://notion.so/page_1",
                    parentExternalId: null,
                  },
                  {
                    externalId: "page_2",
                    type: "page",
                    title: "Feature scoping",
                    url: "https://notion.so/page_2",
                    parentExternalId: null,
                  },
                ],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                `/${orgSlug}/api/v1/repositories`,
              ),
            () => HttpResponse.json({ items: [] }),
          ),
        ],
      },
    },
  },
}
