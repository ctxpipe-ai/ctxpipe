import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  plainCatalogHandler,
  plainStatusHandler,
  plainStoryStatus,
} from "@/mocks/plain-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceChangeHandlers,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import { PlainSetupDialog } from "./PlainSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_plain"

/** The dialog with its connection id in state, as the Connectors page holds it. */
function Dialog(props: { connectionId?: string; reconnect?: boolean }) {
  const [id, setId] = useState(props.connectionId)
  return (
    <PlainSetupDialog
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
  title: "Components/Connections/PlainSetupDialog",
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

const calls: unknown[] = []
const recordConnect = (response: () => Response) =>
  http.post(
    ({ request }) =>
      new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors/plain`,
    async ({ request }) => {
      calls.push(await request.json())
      return response()
    },
  )

async function visible(element: HTMLElement) {
  // The modal fades in; wait until the step is visible.
  await waitFor(() => expect(element).toBeVisible())
  return element
}

const workspacesHandlers = [
  plainStatusHandler(plainStoryStatus()),
  workspaceListHandler([docsWorkspace]),
  connectionUsageHandler([]),
  plainCatalogHandler,
]

export const ConnectWithKey: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          recordConnect(() => HttpResponse.json({ connectionId })),
          ...workspacesHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    const key = await visible(await body.findByLabelText("API key"))
    const connect = body.getByRole("button", { name: "Connect Plain" })
    await expect(connect).toBeDisabled()
    // The key reads content and manages only its own webhook target.
    await expect(body.getByText("thread:read")).toBeVisible()
    await expect(body.getByText("webhookTarget:create")).toBeVisible()
    // Product links are teal, not the default blue.
    const keyLink = body.getByRole("link", { name: /API key/ })
    await expect(keyLink.className).toContain("text-teal-400")
    await expect(keyLink.className).not.toMatch(/blue/)
    await expect(body.queryByText("thread:edit")).toBeNull()
    await userEvent.type(key, "plainApiKey_fixture")
    await userEvent.click(connect)
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Add Plain to Workspaces" }),
      ).toBeVisible(),
    )
    await expect(calls).toEqual([{ apiKey: "plainApiKey_fixture" }])
  },
}

export const KeyRefused: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          recordConnect(() =>
            HttpResponse.json(
              {
                error:
                  "The Plain API key does not have these permissions: timeline:read",
              },
              { status: 400 },
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await visible(await body.findByLabelText("API key")),
      "plainApiKey_bad",
    )
    await userEvent.click(body.getByRole("button", { name: "Connect Plain" }))
    await waitFor(() =>
      expect(
        body.getByText(
          "The Plain API key does not have these permissions: timeline:read",
        ),
      ).toBeVisible(),
    )
    await expect(
      body.getByRole("heading", { name: "Connect Plain" }),
    ).toBeVisible()
  },
}

const addCalls: { method: string; path: string; body: unknown }[] = []

export const AddToWorkspaces: Story = {
  name: "Add Plain to Workspaces",
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          ...workspacesHandlers,
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Add Plain to Workspaces" }),
    )
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(await body.findByRole("checkbox", { name: "Bug" }))
    await userEvent.click(add)
    // The add opened a pull request: the last step is the merge.
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
            provider: "plain",
            connectionId,
            scope: { labels: ["lt_bug"] },
          },
        },
      },
    ])
  },
}

export const Reconnect: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          plainStatusHandler(plainStoryStatus({ status: "revoked" })),
          recordConnect(() => HttpResponse.json({ connectionId })),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(await body.findByText(/Plain does not accept the saved key/))
    await userEvent.type(body.getByLabelText("API key"), "plainApiKey_new")
    await userEvent.click(body.getByRole("button", { name: "Connect Plain" }))
    await waitFor(() =>
      expect(calls).toEqual([{ apiKey: "plainApiKey_new", connectionId }]),
    )
  },
}

export const ReconnectForTheWebhook: Story = {
  args: { connectionId, reconnect: true },
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
    const body = within(canvasElement.ownerDocument.body)
    // A working connection opens at the key: a reconnect adds the target.
    await visible(await body.findByLabelText("API key"))
    await expect(
      body.getByText(/ctxpipe tries to add the webhook again/),
    ).toBeVisible()
  },
}
