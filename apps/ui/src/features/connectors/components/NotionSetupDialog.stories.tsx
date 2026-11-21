import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { notionResourcesHandler } from "@/mocks/notion-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceAddHandlers,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import { NotionSetupDialog } from "./NotionSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = preview.meta({
  title: "Components/Connections/NotionSetupDialog",
  component: NotionSetupDialog,
  args: {
    orgSlug,
    isOpen: true,
    onOpenChange: () => {},
  },
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

const draftStatus = {
  isInstalled: false,
  installationStatus: null,
  workspaceName: null,
  isGithubLinked: false,
  selectedResourceCount: 0,
  syncTargetConfigured: false,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
}

function notionStatus(status: object) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes(
        "/api/v1/connectors/notion/status",
      ),
    () => HttpResponse.json(status),
  )
}

function dialog() {
  return (
    <NotionSetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
    />
  )
}

/**
 * Notion setup dialog on a self-hosted install: the admin saves a private OAuth
 * app, and the dialog moves on to wait for the webhook token.
 */
export const RegisterNotionOauth = meta.story({
  name: "Register Notion OAuth app (self-hosted)",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      ...[
        notionStatus(draftStatus),
        (() => {
          let saved = false
          let clientId: string | null = null
          return [
            http.get(
              ({ request }) => {
                const u = new URL(request.url)
                return (
                  u.pathname ===
                    `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
                  u.searchParams.get("connectionId") === connectionId
                )
              },
              ({ request }) => {
                const origin = new URL(request.url).origin
                return HttpResponse.json({
                  oauthConfigured: saved,
                  oauthAppSaved: saved,
                  oauthClientId: clientId,
                  webhookConfigured: false,
                  webhookVerificationToken: null,
                  globalNotionOAuthConfigured: false,
                  callbackUrl: `${origin}/api/v1/connectors/notion/oauth/callback`,
                  webhookUrl: saved
                    ? `${origin}/api/v1/webhook/notion?connectionId=${connectionId}&provisioningToken=story`
                    : `${origin}/api/v1/webhook/notion`,
                })
              },
            ),
            http.put(
              ({ request }) => {
                const u = new URL(request.url)
                return (
                  u.pathname ===
                    `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
                  u.searchParams.get("connectionId") === connectionId
                )
              },
              async ({ request }) => {
                const body = (await request.json()) as {
                  clientId?: string
                }
                saved = true
                clientId = body.clientId ?? "notion-client-id"
                return new HttpResponse(null, { status: 204 })
              },
            ),
          ]
        })(),
      ].flat(),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as AddNotionWebhookWaiting.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("heading", { name: "Register Notion OAuth app" })
    await expect(body.queryByText("Event URL")).toBeNull()
    await userEvent.type(
      await body.findByRole("textbox", { name: "Client ID" }),
      "client_123",
    )
    await userEvent.type(body.getByLabelText("Client secret"), "secret_abc")
    await userEvent.click(body.getByRole("button", { name: "Save OAuth app" }))
    await body.findByText(/Waiting for Notion to send a verification token/)
    await expect(body.queryByRole("textbox", { name: "Client ID" })).toBeNull()
  },
})

/**
 * Notion setup dialog at the webhook step: the OAuth app is saved and ctxpipe
 * waits for Notion to send the verification token.
 */
export const AddNotionWebhookWaiting = meta.story({
  name: "Add the webhook (waiting for token)",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      notionStatus(draftStatus),
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
        oauthClientId: "notion-client-id-story",
        webhookConfigured: false,
        webhookVerificationToken: null,
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText(/Waiting for Notion to send a verification token/)
    await expect(body.queryByRole("textbox", { name: "Client ID" })).toBeNull()
  },
})

/**
 * Notion setup dialog at the webhook step: the verification token arrived and
 * shows for the admin to paste in Notion.
 */
export const AddNotionWebhookToken = meta.story({
  name: "Add the webhook (verification token received)",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      notionStatus(draftStatus),
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
        oauthClientId: "notion-client-id-story",
        webhookConfigured: true,
        webhookVerificationToken: "secret_story-verify-token",
      }),
    )
  },
})

/**
 * Notion setup dialog after the webhook step: the admin continues and the
 * dialog offers the Connect Notion button.
 */
export const ConnectNotionAfterWebhook = meta.story({
  name: "Connect Notion after webhook",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      notionStatus(draftStatus),
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
        oauthClientId: "notion-client-id-story",
        webhookConfigured: true,
        webhookVerificationToken: "secret_story-verify-token",
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const continueButton = await canvas.findByRole("button", {
      name: "Continue",
    })
    await waitFor(() => expect(continueButton).not.toBeDisabled())
    await userEvent.click(continueButton)
    await canvas.findByRole("button", { name: "Connect Notion" })
  },
})

/**
 * Notion setup dialog on the hosted product, where ctxpipe supplies the OAuth
 * app: the first step asks the admin to authorize ctxpipe in Notion.
 */
export const ConnectNotionGlobalEnv = meta.story({
  name: "Connect Notion (hosted env OAuth)",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      notionStatus(draftStatus),
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: false,
        globalNotionOAuthConfigured: true,
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("button", { name: "Connect Notion" })
    await expect(body.queryByText("Register Notion OAuth app")).toBeNull()
  },
})

const installedStatus = {
  ...draftStatus,
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme notes",
}

const addCalls: { method: string; path: string; body: unknown }[] = []

const installedHandlers = [
  notionStatus(installedStatus),
  notionOauthAppHandler({
    orgSlug,
    connectionId,
    oauthAppSaved: false,
    globalNotionOAuthConfigured: true,
  }),
  workspaceListHandler([docsWorkspace]),
  notionResourcesHandler,
  ...workspaceSourceAddHandlers(addCalls),
  connectionUsageHandler([]),
]

/**
 * Notion setup dialog after the connect: the admin adds Notion pages to a
 * Workspace, and the dialog links the pull request to merge.
 */
export const AddToWorkspaces = meta.story({
  name: "Add Notion to Workspaces",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(...installedHandlers)
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    const heading = await body.findByRole("heading", {
      name: "Add Notion to Workspaces",
    })
    // The modal fades in; wait until the step is visible.
    await waitFor(() => expect(heading).toBeVisible())
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: /Engineering handbook/ }),
    )
    await userEvent.click(add)
    // The add opened a pull request: the last step is the merge.
    const merge = await body.findByRole("heading", {
      name: "Merge the pull request",
    })
    await waitFor(() => expect(merge).toBeVisible())
    // The sync starts after the merge, so the last step links the pull request.
    await expect(
      body.getByRole("link", { name: /^acme\/docs#7/ }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
    await expect(addCalls).toEqual([
      {
        method: "POST",
        path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
        body: {
          source: {
            provider: "notion",
            connectionId,
            scope: {
              pages: [
                {
                  id: "1a2b3c4d-0000-4000-8000-000000000001",
                  title: "Engineering handbook",
                },
              ],
            },
          },
        },
      },
    ])
  },
})

/**
 * Notion setup dialog for a connection that is already installed: a newer setup
 * replaced this one and a config pull request waits for a merge.
 */
export const ReplacedSetup = meta.story({
  name: "Replaced setup with a config pull request",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      notionStatus({
        ...installedStatus,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: "https://github.com/acme/notes/pull/3",
      }),
      ...installedHandlers.slice(1),
    )
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const notice = await body.findByText(/This setup was replaced/)
    // The modal fades in; wait until the notice is visible.
    await waitFor(() => expect(notice).toBeVisible())
    await expect(
      body.getByRole("link", { name: /^configuration pull request/ }),
    ).toHaveAttribute("href", "https://github.com/acme/notes/pull/3")
  },
})
