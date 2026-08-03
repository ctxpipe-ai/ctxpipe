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

const githubInstallationHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  () =>
    HttpResponse.json({
      id: "con_github",
      appSlug: "ctxpipe-pr-153",
      accountSlug: "acme",
    }),
)

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

export const TargetRepository: Story = {
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
          githubInstallationHandler,
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
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: null,
                selectedResources: [],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/config",
              ),
            () => HttpResponse.json({ resources: [], syncTarget: null }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/repositories`,
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_context",
                    name: "acme/context",
                    gitUrl: "https://github.com/acme/context.git",
                  },
                ],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/connectors/suggested-sync-target",
              ),
            () =>
              HttpResponse.json({
                target: {
                  repositoryId: "repo_context",
                  repositoryName: "acme/context",
                  gitUrl: "https://github.com/acme/context.git",
                  branch: "main",
                  usedBy: ["confluence"],
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/github/installation/repositories",
              ),
            () =>
              HttpResponse.json({
                repositories: [
                  {
                    id: 100,
                    full_name: "acme/context",
                    html_url: "https://github.com/acme/context",
                    clone_url: "https://github.com/acme/context.git",
                    name: "context",
                    default_branch: "main",
                  },
                  {
                    id: 101,
                    full_name: "acme/notion-target",
                    html_url: "https://github.com/acme/notion-target",
                    clone_url: "https://github.com/acme/notion-target.git",
                    name: "notion-target",
                    default_branch: "main",
                  },
                ],
                repositorySelection: "selected",
                manageUrl:
                  "https://github.com/organizations/acme/settings/installations/123",
                hasMore: false,
              }),
          ),
        ],
      },
    },
  },
}
