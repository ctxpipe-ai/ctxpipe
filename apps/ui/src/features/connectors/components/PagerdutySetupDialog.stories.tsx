import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { pagerdutyServicesHandler } from "@/mocks/pagerduty-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceAddHandlers,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { docsWorkspace } from "../../workspaces/workspace-fixtures"
import { PagerdutySetupDialog } from "./PagerdutySetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_pagerduty"
const saveOauthAppRequest = fn()

const hostedOauth = {
  oauthAppSaved: false,
  globalPagerdutyOAuthConfigured: true,
  oauthCallbackUrl:
    "https://app.example.com/api/v1/integrations/pagerduty/callback",
}

const meta = preview.meta({
  title: "Components/Connections/PagerdutySetupDialog",
  component: PagerdutySetupDialog,
  args: {
    orgSlug,
    isOpen: true,
    onOpenChange: () => {},
    onConnectionIdChange: () => {},
  },
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

/**
 * PagerDuty setup dialog on a self-hosted install: the admin saves a private
 * OAuth app, and the secret field clears after the save.
 */
export const RegisterOAuthApp = meta.story({
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.includes(
            "/api/v1/connectors/pagerduty/status",
          ),
        () =>
          HttpResponse.json({
            isInstalled: false,
            installationStatus: "pending",
            accountName: null,
            accountSubdomain: null,
            region: null,
            isGithubLinked: false,
            selectedServiceCount: null,
            syncTargetConfigured: false,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
            syncTarget: null,
            oauthAppSaved: false,
            globalPagerdutyOAuthConfigured: false,
            oauthCallbackUrl: hostedOauth.oauthCallbackUrl,
          }),
      ),
      http.put(
        ({ request }) =>
          new URL(request.url).pathname.includes(
            "/api/v1/connectors/pagerduty/oauth-app",
          ),
        async ({ request }) => {
          saveOauthAppRequest(await request.json())
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const clientId = await canvas.findByLabelText("Client ID")
    // The modal fades in; wait until the form is visible.
    await waitFor(() => expect(clientId).toBeVisible())
    await userEvent.type(clientId, "pd-client")
    await userEvent.type(canvas.getByLabelText("Client secret"), "pd-secret")
    await userEvent.click(
      canvas.getByRole("button", { name: "Save OAuth app" }),
    )
    await waitFor(() =>
      expect(saveOauthAppRequest).toHaveBeenCalledWith({
        clientId: "pd-client",
        clientSecret: "pd-secret",
      }),
    )
    await expect(canvas.getByLabelText("Client secret")).toHaveValue("")
  },
})

/**
 * PagerDuty setup dialog for a new connection on the hosted product: the first
 * step, with the Connect PagerDuty button and the step list.
 */
export const ConnectAccount = meta.story({
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.endsWith(
            "/api/v1/connectors/pagerduty/oauth/start",
          ),
        () =>
          HttpResponse.json({
            authorizationUrl: "https://identity.pagerduty.com/oauth/authorize",
          }),
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("heading", { name: "Connect PagerDuty" })
    const connect = body.getByRole("button", { name: "Connect PagerDuty" })
    // The modal fades in; wait until the step is visible.
    await waitFor(() => expect(connect).toBeVisible())
    const stepper = within(body.getByRole("list"))
    expect(stepper.getByText("Connect PagerDuty")).toBeVisible()
    expect(stepper.getByText("Add to Workspaces")).toBeVisible()
  },
})

const installedStatus = {
  isInstalled: true,
  installationStatus: "installed",
  accountName: "Acme Test",
  accountSubdomain: "acme-test",
  region: "us",
  isGithubLinked: false,
  selectedServiceCount: null,
  syncTargetConfigured: false,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
  ...hostedOauth,
}

function pagerdutyStatus(status: object) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes(
        "/api/v1/connectors/pagerduty/status",
      ),
    () => HttpResponse.json(status),
  )
}

function dialog() {
  return (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  )
}

const addCalls: { method: string; path: string; body: unknown }[] = []

const installedHandlers = [
  pagerdutyStatus(installedStatus),
  workspaceListHandler([docsWorkspace]),
  pagerdutyServicesHandler,
  ...workspaceSourceAddHandlers(addCalls),
  connectionUsageHandler([]),
]

/**
 * PagerDuty setup dialog after the connect: the admin adds a PagerDuty service
 * to a Workspace, and the dialog links the pull request to merge.
 */
export const AddToWorkspaces = meta.story({
  name: "Add PagerDuty to Workspaces",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(...installedHandlers)
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    const heading = await body.findByRole("heading", {
      name: "Add PagerDuty to Workspaces",
    })
    // The modal fades in; wait until the step is visible.
    await waitFor(() => expect(heading).toBeVisible())
    // The old repository, scope, and pull request steps are gone.
    await expect(body.queryByText("Select sync repository")).toBeNull()
    await expect(body.queryByText(/pagerduty\/config\.yaml/)).toBeNull()
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: "checkout-api" }),
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
            provider: "pagerduty",
            connectionId,
            scope: { services: ["PSVC001"] },
          },
        },
      },
    ])
  },
})

/**
 * PagerDuty setup dialog at Add to Workspaces for a connection from an earlier
 * setup: a warning says ctxpipe no longer uses its open configuration pull
 * request.
 */
export const ReplacedSetup = meta.story({
  name: "Replaced setup with a config pull request",
  render: () => dialog(),
  beforeEach: ({ msw }) => {
    msw.use(
      pagerdutyStatus({
        ...installedStatus,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: "https://github.com/acme/on-call/pull/4",
      }),
      ...installedHandlers.slice(1),
    )
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const notice = await body.findByText(/This setup was replaced/)
    // The modal fades in; wait until the notice is visible.
    await waitFor(() => expect(notice).toBeVisible())
    await expect(
      body.getByRole("link", { name: /^configuration pull request/ }),
    ).toHaveAttribute("href", "https://github.com/acme/on-call/pull/4")
  },
})
