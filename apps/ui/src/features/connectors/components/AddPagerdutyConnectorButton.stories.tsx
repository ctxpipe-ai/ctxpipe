import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { AddPagerdutyConnectorButton } from "./AddPagerdutyConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddPagerdutyConnectorButton",
  component: AddPagerdutyConnectorButton,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddPagerdutyConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const Idle: Story = {
  render: () => (
    <div className="w-96">
      <AddPagerdutyConnectorButton orgSlug={orgSlug} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/oauth/start",
              ),
            () =>
              HttpResponse.json({
                authorizationUrl:
                  "https://identity.pagerduty.com/oauth/authorize",
              }),
          ),
        ],
      },
    },
  },
}

export const Starting: Story = {
  render: () => (
    <div className="w-96">
      <AddPagerdutyConnectorButton orgSlug={orgSlug} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/oauth/start",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json({
                authorizationUrl:
                  "https://identity.pagerduty.com/oauth/authorize",
              })
            },
          ),
        ],
      },
    },
  },
}
