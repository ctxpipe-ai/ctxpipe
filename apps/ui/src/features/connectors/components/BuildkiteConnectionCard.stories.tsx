import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import { signedInHandlers } from "@/mocks/handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  activeMemberRoleHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { BuildkiteConnectionCard } from "./BuildkiteConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_buildkite"
const onOpenSetup = fn()

const meta = preview.meta({
  title: "Components/Connections/BuildkiteCard",
  component: BuildkiteConnectionCard,
  args: { orgSlug, connectionId, onOpenSetup },
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("admin"),
      pendingWorkspaceUpgradesHandler({}),
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
        }),
      ]),
    )
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: { pattern: "orgIndex", orgSlug } satisfies StoryRouteParams,
  },
})

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>
const card = () =>
  shell(
    <BuildkiteConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />,
  )

/**
 * Buildkite connection card on the Connectors page: connected with the webhook
 * set up, card open with the Manage action.
 */
export const Connected = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
    )
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
    await userEvent.click(canvas.getByRole("button", { name: "Buildkite" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    await expect(onOpenSetup).toHaveBeenCalledWith()
  },
})

/**
 * Buildkite connection card on the Connectors page: connected but with no
 * webhook, so builds sync once a day and an Add the webhook action shows.
 */
export const WebhookMissing = meta.story({
  name: "No webhook, setup opens at the webhook step",
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(buildkiteStatusHandler(buildkiteStoryStatus()))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Connected")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Buildkite" }))
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
})

/**
 * Buildkite connection card on the Connectors page: the webhook is saved and
 * the card offers to replace its token.
 */
export const ReplaceWebhookToken = meta.story({
  name: "Webhook saved, its token can be replaced",
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Connected")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Buildkite" }))
    await userEvent.click(
      await canvas.findByRole("button", { name: "Replace the webhook token" }),
    )
    await expect(onOpenSetup).toHaveBeenCalledWith({ replaceWebhook: true })
  },
})

/**
 * Buildkite card on the Connectors page, opened by the admin: Buildkite no
 * longer accepts the saved token, so the status is Needs reconnect and the
 * details end with Reconnect Buildkite.
 */
export const RevokedOpensReconnect = meta.story({
  name: "Revoked, reconnect opens setup",
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(
        buildkiteStoryStatus({
          status: "revoked",
          webhookConfigured: true,
        }),
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Needs reconnect")).toBeInTheDocument(),
    )
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Buildkite" }))
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
})

const deleted = fn()

/**
 * Buildkite connection card on the Connectors page: the user removes the
 * connector through the actions menu and a confirm dialog.
 */
export const Remove = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
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
    )
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
})

/**
 * Buildkite connection card on the Connectors page: the status request has not
 * returned, so the card is still checking.
 */
export const Checking = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
})
