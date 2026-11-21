import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { plainStatusHandler, plainStoryStatus } from "@/mocks/plain-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  activeMemberRoleHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { PlainConnectionCard } from "./PlainConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_plain"
const onOpenSetup = fn()

const meta = preview.meta({
  title: "Components/Connections/PlainCard",
  component: PlainConnectionCard,
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
    <PlainConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />,
  )

/**
 * Plain card on the Connectors page, opened by the admin: the Plain workspace
 * is connected and used in one Workspace, and the details end with Manage.
 */
export const Connected = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(plainStatusHandler(plainStoryStatus()))
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
    await userEvent.click(canvas.getByRole("button", { name: "Plain" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    await expect(onOpenSetup).toHaveBeenCalledWith()
  },
})

/**
 * Plain connection card on the Connectors page: Plain did not accept the
 * webhook, so threads sync once a day and the card offers a reconnect.
 */
export const WebhookMissing = meta.story({
  name: "No webhook, a reconnect adds it",
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(plainStatusHandler(plainStoryStatus({ webhookConfigured: false })))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Connected")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Plain" }))
    await waitFor(() =>
      expect(
        canvas.getByText(/Threads sync once a day: Plain did not accept/),
      ).toBeVisible(),
    )
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Plain/,
    })
    if (!reconnect) throw new Error("No Reconnect Plain action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledWith({ reconnect: true })
  },
})

/**
 * Plain connection card on the Connectors page: Plain no longer accepts the
 * saved key, so the card shows Needs reconnect.
 */
export const RevokedOpensReconnect = meta.story({
  name: "Revoked, reconnect opens setup",
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(plainStatusHandler(plainStoryStatus({ status: "revoked" })))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Plain" }))
    await expect(
      canvas.getByText(/Plain does not accept the saved key/),
    ).toBeVisible()
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect Plain/,
    })
    if (!reconnect) throw new Error("No Reconnect Plain action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledWith({ reconnect: true })
  },
})

const deleted = fn()

/**
 * Plain connection card on the Connectors page: the admin removes the connector
 * and confirms in the remove dialog.
 */
export const Remove = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
      plainStatusHandler(plainStoryStatus()),
      http.delete(
        ({ request }) =>
          new URL(request.url).pathname.endsWith("/api/v1/connectors/plain"),
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
})

/**
 * Plain card on the Connectors page right after the page opens: the status read
 * has not returned, so a pulsing gray dot shows Checking.
 */
export const Checking = meta.story({
  render: card,
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
})
