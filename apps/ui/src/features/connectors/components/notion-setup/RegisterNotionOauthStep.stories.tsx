import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import {
  notionOauthAppHandler,
  notionOauthAppPutHandler,
} from "../../mocks/notion-oauth-app-msw"
import { RegisterNotionOauthStep } from "./RegisterNotionOauthStep"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = {
  title: "Components/Connections/Notion/Steps/RegisterOAuth",
  component: RegisterNotionOauthStep,
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-2">
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
} satisfies Meta<typeof RegisterNotionOauthStep>

export default meta

type Story = StoryObj<typeof meta>

export const RegisterOAuth: Story = {
  name: "Private OAuth app form",
  render: () => (
    <RegisterNotionOauthStep orgSlug={orgSlug} connectionId={connectionId} />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: false,
            globalNotionOAuthConfigured: false,
          }),
          notionOauthAppPutHandler({ orgSlug, connectionId }),
        ],
      },
    },
  },
}
