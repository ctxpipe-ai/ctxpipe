import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { plainStatusHandler, plainStoryStatus } from "@/mocks/plain-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PlainConnectionCard } from "./PlainConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_plain"
const onOpenSetup = fn()

const meta = {
  title: "Components/Connections/PlainCard",
  component: PlainConnectionCard,
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
} satisfies Meta<typeof PlainConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>
const card = () =>
  shell(
    <PlainConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />,
  )

export const Connected: Story = {
  render: card,
  parameters: {
    msw: { handlers: { page: [plainStatusHandler(plainStoryStatus())] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Connected")).toBeInTheDocument()
    // The Plain workspace name is the account name.
    await expect(canvas.getByText("Acme Support")).toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /Reconnect Plain/ }),
    ).toBeNull()
    // As on the other connector cards, Manage opens the setup at the
    // Workspaces step, not at the key.
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Expand Plain" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    await expect(onOpenSetup).toHaveBeenCalledWith()
  },
}

export const WebhookMissing: Story = {
  name: "No webhook, a reconnect adds it",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          plainStatusHandler(plainStoryStatus({ webhookConfigured: false })),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Connected")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Expand Plain" }))
    await expect(
      await canvas.findByText(/Threads sync once a day: Plain did not accept/),
    ).toBeVisible()
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Plain/,
    })
    if (!reconnect) throw new Error("No Reconnect Plain action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledWith({ reconnect: true })
  },
}

export const RevokedOpensReconnect: Story = {
  name: "Revoked, reconnect opens setup",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [plainStatusHandler(plainStoryStatus({ status: "revoked" }))],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Expand Plain" }))
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Plain/,
    })
    if (!reconnect) throw new Error("No Reconnect Plain action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledWith({ reconnect: true })
  },
}

const deleted = fn()

export const Remove: Story = {
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          plainStatusHandler(plainStoryStatus()),
          http.delete(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/plain",
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
      canvas.getByRole("button", { name: "Plain connector actions" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Remove connector" }),
    )
    const dialog = await body.findByRole("alertdialog")
    // The dialog fades in; the remove also deletes the webhook target.
    await waitFor(() =>
      expect(
        within(dialog).getByText(/its webhook target in Plain/),
      ).toBeVisible(),
    )
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
                "/api/v1/connectors/plain/status",
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
