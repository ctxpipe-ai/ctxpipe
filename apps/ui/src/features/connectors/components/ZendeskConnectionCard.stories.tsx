import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import {
  zendeskStatusHandler,
  zendeskStoryStatus,
} from "@/mocks/zendesk-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ZendeskConnectionCard } from "./ZendeskConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_zendesk"
const onOpenSetup = fn()

const meta = {
  title: "Components/Connections/ZendeskCard",
  component: ZendeskConnectionCard,
  args: { orgSlug, connectionId, onOpenSetup },
  decorators: entryPageInnerDecorators,
  parameters: {
    msw: {
      handlers: {
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
            }),
          ]),
        ],
      },
    },
    layout: "fullscreen",
    storyRoute: { pattern: "orgIndex", orgSlug } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof ZendeskConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>
const card = () =>
  shell(
    <ZendeskConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />,
  )

export const Connected: Story = {
  render: card,
  parameters: {
    msw: { handlers: { page: [zendeskStatusHandler(zendeskStoryStatus())] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Connected")).toBeInTheDocument()
    // The subdomain is the account name.
    await expect(canvas.getByText("acme")).toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /^Reconnect/ }),
    ).toBeNull()
    // As on the other connector cards, Manage opens the setup at the
    // Workspaces step, not at the authorization.
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Zendesk" }),
    )
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    await expect(onOpenSetup).toHaveBeenCalledWith()
  },
}

export const NoWebhook: Story = {
  name: "No webhook: articles sync once a day",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler(
            zendeskStoryStatus({ webhookConfigured: false }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Connected")).toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Zendesk" }),
    )
    await expect(
      await canvas.findByText(/Help Center articles sync once a day/),
    ).toBeVisible()
    onOpenSetup.mockClear()
    const [add] = await canvas.findAllByRole("button", {
      name: /^Add the webhook/,
    })
    if (!add) throw new Error("No Add the webhook action")
    await userEvent.click(add)
    await expect(onOpenSetup).toHaveBeenCalledWith({ reconnect: true })
  },
}

export const RevokedOpensReconnect: Story = {
  name: "Revoked, reconnect opens setup",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [zendeskStatusHandler(zendeskStoryStatus({ status: "revoked" }))],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Zendesk" }),
    )
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Zendesk/,
    })
    if (!reconnect) throw new Error("No Reconnect Zendesk action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
}

const deleted = fn()

export const Remove: Story = {
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          zendeskStatusHandler(zendeskStoryStatus()),
          http.delete(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/zendesk",
              ),
            ({ request }) => {
              deleted(new URL(request.url).searchParams.get("connectionId"))
              return new HttpResponse(null, { status: 204 })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    deleted.mockClear()
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    await userEvent.click(
      canvas.getByRole("button", { name: "Zendesk connector actions" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Remove connector" }),
    )
    const dialog = await body.findByRole("alertdialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove connector" }),
    )
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(connectionId))
  },
}

export const Checking: Story = {
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/zendesk/status",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json({})
            },
          ),
        ],
      },
    },
  },
}
