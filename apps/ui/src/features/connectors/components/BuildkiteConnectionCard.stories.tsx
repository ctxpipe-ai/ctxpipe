import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { BuildkiteConnectionCard } from "./BuildkiteConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_buildkite"
const onOpenSetup = fn()

const meta = {
  title: "Components/Connections/BuildkiteCard",
  component: BuildkiteConnectionCard,
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
} satisfies Meta<typeof BuildkiteConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>
const card = () =>
  shell(
    <BuildkiteConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />,
  )

export const Connected: Story = {
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          buildkiteStatusHandler(
            buildkiteStoryStatus({ webhookConfigured: true }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Connected")).toBeInTheDocument(),
    )
    // The organization slug is the account name.
    await expect(canvas.getByText("acme")).toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /Add the webhook/ }),
    ).toBeNull()
    // As on the other connector cards, Manage opens the setup at the
    // Workspaces step.
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Buildkite" }),
    )
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    await expect(onOpenSetup).toHaveBeenCalledWith()
  },
}

export const WebhookMissing: Story = {
  name: "No webhook, setup opens at the webhook step",
  render: card,
  parameters: {
    msw: {
      handlers: { page: [buildkiteStatusHandler(buildkiteStoryStatus())] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Connected")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Buildkite" }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/Builds sync once a day until you add the webhook/),
      ).toBeVisible(),
    )
    const [add] = await canvas.findAllByRole("button", {
      name: /^Add the webhook/,
    })
    if (!add) throw new Error("No Add the webhook action")
    await userEvent.click(add)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
}

export const ReplaceWebhookToken: Story = {
  name: "Webhook saved, its token can be replaced",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          buildkiteStatusHandler(
            buildkiteStoryStatus({ webhookConfigured: true }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Connected")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Buildkite" }),
    )
    await userEvent.click(
      await canvas.findByRole("button", { name: "Replace the webhook token" }),
    )
    await expect(onOpenSetup).toHaveBeenCalledWith({ replaceWebhook: true })
  },
}

export const RevokedOpensReconnect: Story = {
  name: "Revoked, reconnect opens setup",
  render: card,
  parameters: {
    msw: {
      handlers: {
        page: [
          buildkiteStatusHandler(
            buildkiteStoryStatus({
              status: "revoked",
              webhookConfigured: true,
            }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Needs reconnect")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand Buildkite" }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/Buildkite does not accept the saved token/),
      ).toBeVisible(),
    )
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Buildkite/,
    })
    if (!reconnect) throw new Error("No Reconnect Buildkite action")
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
          buildkiteStatusHandler(
            buildkiteStoryStatus({ webhookConfigured: true }),
          ),
          http.delete(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/buildkite",
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
      canvas.getByRole("button", { name: "Buildkite connector actions" }),
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
                "/api/v1/connectors/buildkite/status",
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
