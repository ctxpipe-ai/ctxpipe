import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { notionResourcesHandler } from "@/mocks/notion-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceChangeHandlers,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import { NotionSetupDialog } from "./NotionSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = {
  title: "Components/Connections/NotionSetupDialog",
  component: NotionSetupDialog,
  args: {
    orgSlug,
    isOpen: true,
    onOpenChange: () => {},
  },
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

export const RegisterNotionOauth: Story = {
  name: "Register Notion OAuth app (self-hosted)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
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
      },
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
}

export const AddNotionWebhookWaiting: Story = {
  name: "Add the webhook (waiting for token)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText(/Waiting for Notion to send a verification token/)
    await expect(body.queryByRole("textbox", { name: "Client ID" })).toBeNull()
  },
}

export const AddNotionWebhookToken: Story = {
  name: "Add the webhook (verification token received)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
}

export const ConnectNotionAfterWebhook: Story = {
  name: "Connect Notion after webhook",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
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
}

export const ConnectNotionGlobalEnv: Story = {
  name: "Connect Notion (hosted env OAuth)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus(draftStatus),
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: false,
            globalNotionOAuthConfigured: true,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("button", { name: "Connect Notion" })
    await expect(body.queryByText("Register Notion OAuth app")).toBeNull()
  },
}

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
  ...workspaceSourceChangeHandlers(addCalls),
  connectionUsageHandler([]),
]

export const AddToWorkspaces: Story = {
  name: "Add Notion to Workspaces",
  render: () => dialog(),
  parameters: { msw: { handlers: { page: installedHandlers } } },
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
}

export const ReplacedSetup: Story = {
  name: "Replaced setup with a config pull request",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus({
            ...installedStatus,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: "https://github.com/acme/notes/pull/3",
          }),
          ...installedHandlers.slice(1),
        ],
      },
    },
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
}
