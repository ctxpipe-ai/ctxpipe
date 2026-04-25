import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { AddConfluenceConnectorButton } from "./AddConfluenceConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddConfluenceConnectorButton",
  component: AddConfluenceConnectorButton,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddConfluenceConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const Idle: Story = {
  render: () => (
    <div className="w-96">
      <AddConfluenceConnectorButton
        orgSlug={orgSlug}
        onInstallIntentRegistered={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: [
        http.post(
          ({ request }) =>
            new URL(request.url).pathname.endsWith(
              "/api/v1/connectors/atlassian/installation",
            ),
          () => HttpResponse.json({ id: "forge_new_1" }),
        ),
      ],
    },
  },
}

export const Submitting: Story = {
  name: "Submitting",
  render: () => (
    <div className="w-96">
      <AddConfluenceConnectorButton
        orgSlug={orgSlug}
        onInstallIntentRegistered={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: [
        http.post(
          ({ request }) =>
            new URL(request.url).pathname.endsWith(
              "/api/v1/connectors/atlassian/installation",
            ),
          async () => {
            await delay("infinite")
            return HttpResponse.json({ id: "forge_new_1" })
          },
        ),
      ],
    },
  },
}
