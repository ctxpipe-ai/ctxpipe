import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceChangeHandlers,
} from "@/mocks/workspace-sources-handlers"
import {
  zendeskCatalogHandler,
  zendeskStatusHandler,
  zendeskStoryStatus,
} from "@/mocks/zendesk-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import type { ZendeskConnectorStatus } from "../queries/zendesk-connector"
import { ZendeskSetupDialog } from "./ZendeskSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_zendesk"

/** The dialog with its connection id in state, as the Connectors page holds it. */
function Dialog(props: { connectionId?: string; reconnect?: boolean }) {
  const [id, setId] = useState(props.connectionId)
  return (
    <ZendeskSetupDialog
      orgSlug={orgSlug}
      connectionId={id}
      reconnect={props.reconnect}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={setId}
    />
  )
}

const meta = {
  title: "Components/Connections/ZendeskSetupDialog",
  component: Dialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: { pattern: "orgIndex", orgSlug } satisfies StoryRouteParams,
  },
  args: {},
} satisfies Meta<typeof Dialog>

export default meta

type Story = StoryObj<typeof meta>

const path =
  (suffix: string) =>
  ({ request }: { request: Request }) =>
    new URL(request.url).pathname.endsWith(
      `/api/v1/connectors/zendesk${suffix}`,
    )

/** A status that a later request can change, as the backend would. */
function liveStatus(initial: ZendeskConnectorStatus) {
  const state = { current: initial }
  return {
    state,
    handler: http.get(path("/status"), () => HttpResponse.json(state.current)),
  }
}

const calls: Array<{ method: string; path: string; body: unknown }> = []
const record = async (request: Request) => {
  calls.push({
    method: request.method,
    path: new URL(request.url).pathname,
    body: request.method === "GET" ? null : await request.json(),
  })
}

async function visible(element: HTMLElement) {
  // The modal fades in; wait until the step is visible.
  await waitFor(() => expect(element).toBeVisible())
  return element
}

const pending = zendeskStoryStatus({
  status: "pending",
  oauthClientConfigured: false,
  oauthClientId: null,
  webhookConfigured: false,
})

const accountStatus = liveStatus(pending)
export const AccountThenOAuthClient: Story = {
  name: "Account, then the OAuth client of a self-hosted deployment",
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(path(""), async ({ request }) => {
            await record(request)
            return HttpResponse.json({ connectionId })
          }),
          accountStatus.handler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    accountStatus.state.current = pending
    const body = within(canvasElement.ownerDocument.body)
    const subdomain = await visible(
      await body.findByLabelText("Zendesk subdomain"),
    )
    await userEvent.type(subdomain, "acme")
    await userEvent.click(body.getByRole("button", { name: "Continue" }))
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Register an OAuth client" }),
      ).toBeVisible(),
    )
    // A dev build shows the callback on the Storybook origin.
    await expect(
      body.getByText(/\/api\/v1\/integrations\/zendesk\/callback$/),
    ).toBeVisible()
    await expect(calls).toEqual([
      {
        method: "POST",
        path: `/${orgSlug}/api/v1/connectors/zendesk`,
        body: { subdomain: "acme" },
      },
    ])
  },
}

const registerStatus = liveStatus(pending)
export const SaveOAuthClient: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          registerStatus.handler,
          http.put(path("/oauth-client"), async ({ request }) => {
            await record(request)
            registerStatus.state.current = {
              ...pending,
              oauthClientConfigured: true,
              oauthClientId: "ctx_local",
            }
            return new HttpResponse(null, { status: 204 })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    registerStatus.state.current = pending
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Register an OAuth client" }),
    )
    // Product links are teal, not the default blue.
    await expect(
      body.getByRole("link", { name: /Admin Center, OAuth clients/ }).className,
    ).toContain("text-teal-400")
    await userEvent.type(body.getByLabelText("Unique identifier"), "ctx_local")
    await userEvent.type(body.getByLabelText("Secret"), "local-secret")
    await userEvent.click(
      body.getByRole("button", { name: "Save OAuth client" }),
    )
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Connect Zendesk" }),
      ).toBeVisible(),
    )
    await expect(body.getByText("ctx_local")).toBeVisible()
    await expect(calls).toEqual([
      {
        method: "PUT",
        path: `/${orgSlug}/api/v1/connectors/zendesk/oauth-client`,
        body: {
          connectionId,
          clientId: "ctx_local",
          clientSecret: "local-secret",
        },
      },
    ])
  },
}

export const HostedSkipsTheOAuthClient: Story = {
  name: "Hosted: no OAuth client step",
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler(
            zendeskStoryStatus({
              status: "pending",
              deploymentOAuthClient: true,
              oauthClientConfigured: true,
              oauthClientId: null,
            }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByRole("heading", { name: "Connect Zendesk" }))
    await expect(body.queryByText("Register an OAuth client")).toBeNull()
    await expect(
      body.queryByRole("button", { name: "Change OAuth client" }),
    ).toBeNull()
  },
}

const connectReady = {
  ...pending,
  oauthClientConfigured: true,
  oauthClientId: "ctxpipe-dev",
}
const connectStatus = liveStatus(connectReady)
export const ConnectThroughThePopup: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          connectStatus.handler,
          http.get(path("/oauth/start"), () =>
            HttpResponse.json({
              authorizationUrl:
                "https://acme.zendesk.com/oauth/authorizations/new?client_id=x",
            }),
          ),
          workspaceListHandler([docsWorkspace]),
          zendeskCatalogHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const view = canvasElement.ownerDocument.defaultView as Window
    const opened: string[] = []
    view.open = ((url: string) => {
      opened.push(url)
      return {} as Window
    }) as typeof view.open
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByRole("heading", { name: "Connect Zendesk" }))
    await userEvent.click(body.getByRole("button", { name: "Connect Zendesk" }))
    await waitFor(() =>
      expect(opened).toEqual([
        "https://acme.zendesk.com/oauth/authorizations/new?client_id=x",
      ]),
    )
    // The callback page posts the result to the setup window.
    connectStatus.state.current = zendeskStoryStatus()
    view.postMessage(
      { type: "zendesk-oauth-complete", orgSlug, connectionId },
      view.location.origin,
    )
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Add Zendesk to Workspaces" }),
      ).toBeVisible(),
    )
  },
}

const changeStatus = liveStatus(connectReady)
export const ChangeOAuthClient: Story = {
  name: "Change a wrong OAuth client",
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          changeStatus.handler,
          http.put(path("/oauth-client"), async ({ request }) => {
            const body = (await request.clone().json()) as { clientId: string }
            await record(request)
            changeStatus.state.current = {
              ...connectReady,
              oauthClientId: body.clientId,
            }
            return new HttpResponse(null, { status: 204 })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    changeStatus.state.current = connectReady
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByRole("heading", { name: "Connect Zendesk" }))
    await expect(body.getByText("ctxpipe-dev")).toBeVisible()
    await expect(body.getByText(/No such client/)).toBeVisible()
    await expect(body.getByText(/acme\.zendesk\.com/)).toBeVisible()

    // Change opens the register step: the identifier is filled in, the secret is empty.
    await userEvent.click(
      body.getByRole("button", { name: "Change OAuth client" }),
    )
    await visible(
      await body.findByRole("heading", { name: "Register an OAuth client" }),
    )
    await expect(body.getByLabelText("Unique identifier")).toHaveValue(
      "ctxpipe-dev",
    )
    await expect(body.getByLabelText("Secret")).toHaveValue("")
    await expect(body.getAllByText("Register an OAuth client").length).toBe(2)

    // Cancel goes back without a save.
    await userEvent.click(body.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Connect Zendesk" }),
      ).toBeVisible(),
    )
    await expect(body.getByText("ctxpipe-dev")).toBeVisible()
    await expect(calls).toEqual([])

    // A save shows the new identifier on the connect step.
    await userEvent.click(
      body.getByRole("button", { name: "Change OAuth client" }),
    )
    const id = await body.findByLabelText("Unique identifier")
    await userEvent.clear(id)
    await userEvent.type(id, "ctxpipe-prod")
    await userEvent.type(body.getByLabelText("Secret"), "new-secret")
    await userEvent.click(
      body.getByRole("button", { name: "Save OAuth client" }),
    )
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Connect Zendesk" }),
      ).toBeVisible(),
    )
    await expect(body.getByText("ctxpipe-prod")).toBeVisible()
    await expect(body.queryByText("ctxpipe-dev")).toBeNull()
    await expect(calls).toEqual([
      {
        method: "PUT",
        path: `/${orgSlug}/api/v1/connectors/zendesk/oauth-client`,
        body: {
          connectionId,
          clientId: "ctxpipe-prod",
          clientSecret: "new-secret",
        },
      },
    ])
  },
}

export const OAuthError: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler({ ...pending, oauthClientConfigured: true }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const view = canvasElement.ownerDocument.defaultView as Window
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByRole("heading", { name: "Connect Zendesk" }))
    view.postMessage(
      {
        type: "zendesk-oauth-error",
        orgSlug,
        error: "Zendesk authorization failed: access_denied",
      },
      view.location.origin,
    )
    await waitFor(() =>
      expect(
        body.getByText("Zendesk authorization failed: access_denied"),
      ).toBeVisible(),
    )
  },
}

export const ReconnectToAddTheWebhook: Story = {
  args: { connectionId, reconnect: true },
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler(
            zendeskStoryStatus({ webhookConfigured: false }),
          ),
          workspaceListHandler([docsWorkspace]),
          zendeskCatalogHandler,
          connectionUsageHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByRole("heading", { name: "Connect Zendesk" }))
    await expect(
      body.getByText(/Connect again as a Zendesk admin/),
    ).toBeVisible()
    // A user who is not a Zendesk admin can go on without the webhook.
    await userEvent.click(
      body.getByRole("button", { name: "Skip to Workspaces" }),
    )
    await visible(
      await body.findByRole("heading", { name: "Add Zendesk to Workspaces" }),
    )
    await expect(
      body.getByText(/Zendesk did not let ctxpipe add the Help Center webhook/),
    ).toBeVisible()
  },
}

const addCalls: Array<{ method: string; path: string; body: unknown }> = []

export const AddToWorkspaces: Story = {
  name: "Add Zendesk to Workspaces",
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler(zendeskStoryStatus()),
          workspaceListHandler([docsWorkspace]),
          zendeskCatalogHandler,
          connectionUsageHandler([]),
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Add Zendesk to Workspaces" }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: "Accounts" }),
    )
    await userEvent.click(
      body.getByRole("button", { name: "Add to Workspaces" }),
    )
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Merge the pull request" }),
      ).toBeVisible(),
    )
    await expect(addCalls).toEqual([
      {
        method: "POST",
        path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
        body: {
          source: {
            provider: "zendesk",
            connectionId,
            scope: { categories: ["360001"] },
          },
        },
      },
    ])
  },
}
