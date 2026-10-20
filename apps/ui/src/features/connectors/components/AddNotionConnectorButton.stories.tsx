import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import { AddNotionConnectorButton } from "./AddNotionConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddNotionConnectorButton",
  component: AddNotionConnectorButton,
  args: { orgSlug, onStart: fn() },
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddNotionConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

const draftId = "con_story_notion_draft"

const draftPost = http.post(
  ({ request }) =>
    new URL(request.url).pathname ===
    `/${orgSlug}/api/v1/connectors/notion/draft`,
  () => HttpResponse.json({ id: draftId, orgId: "org_story" }),
)

let oauthStartCalls = 0
const oauthStart = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/notion/oauth/start",
    ),
  () => {
    oauthStartCalls += 1
    return HttpResponse.json({
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    })
  },
)

export const Idle: Story = {
  render: (args) => (
    <div className="w-96">
      <AddNotionConnectorButton {...args} />
    </div>
  ),
  parameters: { msw: { handlers: { page: [draftPost] } } },
}

export const Starting: Story = {
  render: (args) => (
    <div className="w-96">
      <AddNotionConnectorButton {...args} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/connectors/notion/draft`,
            async () => {
              await delay("infinite")
              return HttpResponse.json({ id: draftId, orgId: "org_story" })
            },
          ),
        ],
      },
    },
  },
}

export const OpensSetup: Story = {
  render: (args) => (
    <div className="w-96">
      <AddNotionConnectorButton {...args} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          draftPost,
          notionOauthAppHandler({
            orgSlug,
            connectionId: draftId,
            globalNotionOAuthConfigured: true,
          }),
          oauthStart,
        ],
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    oauthStartCalls = 0
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /Notion/ }),
    )
    // As for Linear and PagerDuty, the setup dialog opens first. Its
    // "Connect Notion" step starts OAuth.
    await waitFor(() =>
      expect(args.onStart).toHaveBeenCalledWith({ connectionId: draftId }),
    )
    await expect(oauthStartCalls).toBe(0)
  },
}
