import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { OrgAtlassianOauthPanel } from "./OrgAtlassianOauthPanel"

const orgSlug = "acme"
const connectionId = "con_panel_story"

const meta = {
  title: "Components/Connections/Atlassian/OAuthPanel",
  component: OrgAtlassianOauthPanel,
  decorators: [
    (Story) => (
      <div className="w-full min-w-[min(100vw,28rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    review: { kind: "component" },
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof OrgAtlassianOauthPanel>

export default meta

type Story = StoryObj<typeof meta>

const baseHandlers = [
  atlassianOauthHandler({ oauthAppSaved: false }, connectionId),
  atlassianOauthSaveHandler(connectionId),
]

const panel = () => (
  <OrgAtlassianOauthPanel orgSlug={orgSlug} connectionId={connectionId} />
)

export const OAuthPanel: Story = {
  render: panel,
  parameters: {
    review: {
      purpose:
        "Atlassian OAuth panel, where the admin registers a private Atlassian OAuth app for the org: the standalone panel with no OAuth app saved.",
    },
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}

export const OauthAppSaved: Story = {
  render: panel,
  parameters: {
    review: {
      purpose:
        "Atlassian OAuth panel, where the admin registers a private Atlassian OAuth app for the org: the standalone panel with an OAuth app already saved.",
    },
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
          atlassianOauthSaveHandler(connectionId),
        ],
      },
    },
  },
}

export const Embedded: Story = {
  name: "Embedded (wizard)",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Atlassian OAuth panel inside the Atlassian setup wizard, where the admin registers a private OAuth app: no OAuth app is saved yet.",
    },
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}

export const EmbeddedOauthConfigured: Story = {
  name: "Embedded + OAuth configured",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Atlassian OAuth panel inside the Atlassian setup wizard, where the admin registers a private OAuth app: an OAuth app is already saved.",
    },
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
          atlassianOauthSaveHandler(connectionId),
        ],
      },
    },
  },
}
