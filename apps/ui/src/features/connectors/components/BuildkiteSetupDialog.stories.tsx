import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  buildkitePipelinesHandler,
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import { signedInHandlers } from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceAddHandlers,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
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

const meta = preview.meta({
  title: "Components/Connections/BuildkiteSetupDialog",
  component: Dialog,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: { pattern: "orgIndex", orgSlug } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {},
})

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

/**
 * Buildkite setup dialog, which connects a Buildkite org to ctxpipe: the user
 * enters a slug and token and moves on to the webhook step.
 */
export const ConnectWithToken = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      recordConnect(() => HttpResponse.json({ connectionId }, { status: 201 })),
      buildkiteStatusHandler(buildkiteStoryStatus()),
    )
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
    // The link opens Buildkite in a new tab, in the teal link style.
    await expect(tokenLink).toHaveAttribute("target", "_blank")
    await expect(tokenLink.className).toContain("text-teal-400")
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
})

/**
 * Buildkite setup dialog at the Connect Buildkite step: the admin pressed
 * Connect Buildkite, and Buildkite refused the token because it lacks the
 * read_builds scope.
 */
export const TokenRefused = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      recordConnect(() =>
        HttpResponse.json(
          { error: "Give the token these scopes: read_builds." },
          { status: 400 },
        ),
      ),
    )
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
})

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
    // No Workspace uses the new connection yet.
    connectionUsageHandler([]),
  ]
}

/**
 * Buildkite setup dialog, which connects a Buildkite org to ctxpipe: the user
 * saves the webhook token and moves on to the Workspaces step.
 */
export const SaveWebhookToken = meta.story({
  args: { connectionId },
  beforeEach: ({ msw }) => {
    msw.use(...webhookHandlers())
  },
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
    const servicesLink = body.getByRole("link", {
      name: /Notification Services/,
    })
    await expect(servicesLink).toHaveAttribute("target", "_blank")
    await expect(servicesLink.className).toContain("text-teal-400")
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
})

/**
 * Buildkite setup dialog, which connects a Buildkite org to ctxpipe: the
 * webhook step opens with an empty field to replace the saved token.
 */
export const ReplaceWebhookToken = meta.story({
  args: { connectionId, replaceWebhook: true },
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as ConnectWithToken.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await visible(
      await body.findByRole("heading", { name: "Add the Buildkite webhook" }),
    )
    await expect(body.getByLabelText("Webhook token")).toHaveValue("")
  },
})

const addCalls: { method: string; path: string; body: unknown }[] = []

/**
 * Buildkite setup dialog, which connects a Buildkite org to ctxpipe: the user
 * adds a pipeline to a Workspace and reaches the merge step.
 */
export const AddToWorkspaces = meta.story({
  name: "Add Buildkite to Workspaces",
  args: { connectionId },
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
      workspaceListHandler([docsWorkspace]),
      buildkitePipelinesHandler,
      ...workspaceSourceAddHandlers(addCalls),
      connectionUsageHandler([]),
    )
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
})

/**
 * Buildkite setup dialog, which connects a Buildkite org to ctxpipe: the saved
 * token was revoked and the user enters a new token.
 */
export const Reconnect = meta.story({
  args: { connectionId },
  beforeEach: ({ msw }) => {
    msw.use(
      buildkiteStatusHandler(buildkiteStoryStatus({ status: "revoked" })),
      recordConnect(() => HttpResponse.json({ connectionId })),
    )
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
})
