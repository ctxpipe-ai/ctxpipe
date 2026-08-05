import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { AddSlackConnectorButton } from "./AddSlackConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/Slack/AddButton",
  component: AddSlackConnectorButton,
  decorators: [
    (Story) => (
      <div className="w-[min(100vw,24rem)]">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddSlackConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const CatalogRow: Story = {
  render: () => <AddSlackConnectorButton orgSlug={orgSlug} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/slack/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: false,
                installationStatus: null,
                teamName: null,
                isGithubLinked: false,
                selectedChannelCount: 0,
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                oldestDays: null,
                syncTarget: null,
                selectedChannels: [],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/slack/oauth/start",
              ),
            () =>
              HttpResponse.json({
                authorizationUrl: "https://slack.com/oauth/v2/authorize?…",
              }),
          ),
        ],
      },
    },
  },
}
