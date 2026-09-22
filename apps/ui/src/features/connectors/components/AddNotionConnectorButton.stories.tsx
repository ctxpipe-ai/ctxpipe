import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import { AddNotionConnectorButton } from "./AddNotionConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddNotionConnectorButton",
  component: AddNotionConnectorButton,
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

const oauthStart = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/notion/oauth/start",
    ),
  () =>
    HttpResponse.json({
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    }),
)

export const Idle: Story = {
  render: () => (
    <div className="w-96">
      <AddNotionConnectorButton orgSlug={orgSlug} />
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
}

export const Starting: Story = {
  render: () => (
    <div className="w-96">
      <AddNotionConnectorButton orgSlug={orgSlug} />
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
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/notion/oauth/start",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json({
                authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
              })
            },
          ),
        ],
      },
    },
  },
}
