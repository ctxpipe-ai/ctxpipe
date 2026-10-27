import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  buildkitePipelinesHandler,
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceChangeHandlers,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import { BuildkiteSetupDialog } from "./BuildkiteSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_buildkite"

/** The dialog with its connection id in state, as the Connectors page holds it. */
function Dialog(props: { connectionId?: string; replaceWebhook?: boolean }) {
  const [id, setId] = useState(props.connectionId)
  return (
    <BuildkiteSetupDialog
      orgSlug={orgSlug}
      connectionId={id}
      replaceWebhook={props.replaceWebhook}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={setId}
    />
  )
}

const meta = {
  title: "Components/Connections/BuildkiteSetupDialog",
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

const connectPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith("/api/v1/connectors/buildkite")

const calls: { path: string; body: unknown }[] = []
const recordConnect = (response: () => Response) =>
  http.post(connectPath, async ({ request }) => {
    calls.push({
      path: new URL(request.url).pathname,
      body: await request.json(),
    })
    return response()
  })

async function visible(element: HTMLElement) {
  // The modal fades in; wait until the step is visible.
  await waitFor(() => expect(element).toBeVisible())
  return element
}

export const ConnectWithToken: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          recordConnect(() =>
            HttpResponse.json({ connectionId }, { status: 201 }),
          ),
          buildkiteStatusHandler(buildkiteStoryStatus()),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    const slug = await visible(await body.findByLabelText("Organization slug"))
    const connect = body.getByRole("button", { name: "Connect Buildkite" })
    await expect(connect).toBeDisabled()
    // Only the two read scopes that the sync uses.
    await expect(body.getByText("read_pipelines")).toBeVisible()
    await expect(body.getByText("read_builds")).toBeVisible()
    await expect(body.queryByText("read_organizations")).toBeNull()
    const tokenLink = body.getByRole("link", { name: /API access token/ })
    await expect(tokenLink).toHaveAttribute(
      "href",
      "https://buildkite.com/user/api-access-tokens/new",
    )
    // Product links are teal, not the default blue.
    await expect(tokenLink.className).toContain("text-teal-400")
    await expect(tokenLink.className).not.toMatch(/blue/)
    await userEvent.type(slug, "acme")
    await userEvent.type(
      body.getByLabelText("API access token"),
      "bkua_fixture",
    )
    await userEvent.click(connect)
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Add the Buildkite webhook" }),
      ).toBeVisible(),
    )
    await expect(calls).toEqual([
      {
        path: `/${orgSlug}/api/v1/connectors/buildkite`,
        body: { organizationSlug: "acme", apiToken: "bkua_fixture" },
      },
    ])
  },
}

export const TokenRefused: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          recordConnect(() =>
            HttpResponse.json(
              { error: "Give the token these scopes: read_builds." },
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
      await visible(await body.findByLabelText("Organization slug")),
      "acme",
    )
    await userEvent.type(body.getByLabelText("API access token"), "bkua_bad")
    await userEvent.click(
      body.getByRole("button", { name: "Connect Buildkite" }),
    )
    await waitFor(() =>
      expect(
        body.getByText("Give the token these scopes: read_builds."),
      ).toBeVisible(),
    )
    await expect(
      body.getByRole("heading", { name: "Connect Buildkite" }),
    ).toBeVisible()
  },
}

const webhookCalls: unknown[] = []
function webhookHandlers() {
  let configured = false
  return [
    http.get(
      ({ request }) =>
        new URL(request.url).pathname.endsWith(
          "/api/v1/connectors/buildkite/status",
        ),
      () =>
        HttpResponse.json(
          buildkiteStoryStatus({ webhookConfigured: configured }),
        ),
    ),
    http.put(
      ({ request }) =>
        new URL(request.url).pathname.endsWith(
          "/api/v1/connectors/buildkite/webhook-token",
        ),
      async ({ request }) => {
        webhookCalls.push(await request.json())
        configured = true
        return new HttpResponse(null, { status: 204 })
      },
    ),
    workspaceListHandler([docsWorkspace]),
    buildkitePipelinesHandler,
  ]
}

export const SaveWebhookToken: Story = {
  args: { connectionId },
  parameters: { msw: { handlers: { page: webhookHandlers() } } },
  play: async ({ canvasElement }) => {
    webhookCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Add the Buildkite webhook" }),
    )
    await expect(
      body.getByText(
        "https://app.example.com/api/v1/webhook/buildkite/con_story_buildkite",
      ),
    ).toBeVisible()
    // As in the other connector setups, a step has no skip: Close leaves.
    await expect(
      body.queryByRole("button", { name: "Skip for now" }),
    ).toBeNull()
    // Each field of the Buildkite form has its own step.
    await expect(body.getByText(/Clear every event except/)).toBeVisible()
    await expect(
      body.getByRole("link", { name: /Notification Services/ }).className,
    ).toContain("text-teal-400")
    await userEvent.type(body.getByLabelText("Webhook token"), "hook-token")
    await userEvent.click(
      body.getByRole("button", { name: "Save webhook token" }),
    )
    await waitFor(() =>
      expect(
        body.getByRole("heading", {
          name: "Add Buildkite to Workspaces",
        }),
      ).toBeVisible(),
    )
    await expect(webhookCalls).toEqual([
      { connectionId, webhookToken: "hook-token" },
    ])
  },
}

export const ReplaceWebhookToken: Story = {
  args: { connectionId, replaceWebhook: true },
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
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Add the Buildkite webhook" }),
    )
    await expect(body.getByLabelText("Webhook token")).toHaveValue("")
  },
}

const addCalls: { method: string; path: string; body: unknown }[] = []

export const AddToWorkspaces: Story = {
  name: "Add Buildkite to Workspaces",
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          buildkiteStatusHandler(
            buildkiteStoryStatus({ webhookConfigured: true }),
          ),
          workspaceListHandler([docsWorkspace]),
          buildkitePipelinesHandler,
          ...workspaceSourceChangeHandlers(addCalls),
          connectionUsageHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", {
        name: "Add Buildkite to Workspaces",
      }),
    )
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: "Web App" }),
    )
    await userEvent.click(add)
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
            provider: "buildkite",
            connectionId,
            scope: { pipelines: ["web-app"] },
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
          buildkiteStatusHandler(buildkiteStoryStatus({ status: "revoked" })),
          recordConnect(() => HttpResponse.json({ connectionId })),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    calls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByText(/Buildkite does not accept the saved token/),
    )
    // The organization of a connection does not change on a reconnect.
    await expect(body.getByLabelText("Organization slug")).toHaveValue("acme")
    await userEvent.type(body.getByLabelText("API access token"), "bkua_new")
    await userEvent.click(
      body.getByRole("button", { name: "Connect Buildkite" }),
    )
    await waitFor(() =>
      expect(calls).toEqual([
        {
          path: `/${orgSlug}/api/v1/connectors/buildkite`,
          body: {
            organizationSlug: "acme",
            apiToken: "bkua_new",
            connectionId,
          },
        },
      ]),
    )
  },
}
