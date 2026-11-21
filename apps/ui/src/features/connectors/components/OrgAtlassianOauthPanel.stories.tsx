import {
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { OrgAtlassianOauthPanel } from "./OrgAtlassianOauthPanel"

const orgSlug = "acme"
const connectionId = "con_panel_story"

const meta = preview.meta({
  title: "Components/Connections/Atlassian/OAuthPanel",
  component: OrgAtlassianOauthPanel,
  decorators: [
    (Story) => (
      <div className="w-full min-w-[min(100vw,28rem)]">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

const baseHandlers = [
  atlassianOauthHandler({ oauthAppSaved: false }, connectionId),
  atlassianOauthSaveHandler(connectionId),
]

const panel = () => (
  <OrgAtlassianOauthPanel orgSlug={orgSlug} connectionId={connectionId} />
)

/**
 * Atlassian OAuth panel, where the admin registers a private Atlassian OAuth
 * app for the org: the standalone panel with no OAuth app saved.
 */
export const OAuthPanel = meta.story({
  render: panel,
  beforeEach: ({ msw }) => {
    msw.use(...baseHandlers)
  },
})

/**
 * Atlassian OAuth panel, where the admin registers a private Atlassian OAuth
 * app for the org: the standalone panel with an OAuth app already saved.
 */
export const OauthAppSaved = meta.story({
  render: panel,
  beforeEach: ({ msw }) => {
    msw.use(
      atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
      atlassianOauthSaveHandler(connectionId),
    )
  },
})

/**
 * Atlassian OAuth panel inside the Atlassian setup wizard, where the admin
 * registers a private OAuth app: no OAuth app is saved yet.
 */
export const Embedded = meta.story({
  name: "Embedded (wizard)",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  beforeEach: ({ msw }) => {
    msw.use(...baseHandlers)
  },
})

/**
 * Register step of the Confluence setup wizard, opened again from the step list
 * after the save: the panel names the saved Client ID and lets the admin change
 * it or the secret.
 */
export const EmbeddedOauthConfigured = meta.story({
  name: "Embedded + OAuth configured",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
      atlassianOauthSaveHandler(connectionId),
    )
  },
})
