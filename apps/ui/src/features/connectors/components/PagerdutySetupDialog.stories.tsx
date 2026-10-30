import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { pagerdutyServicesHandler } from "@/mocks/pagerduty-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  workspaceSourceChangeHandlers,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
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

const meta = {
  title: "Components/Connections/PagerdutySetupDialog",
  component: PagerdutySetupDialog,
  args: {
    orgSlug,
    isOpen: true,
    onOpenChange: () => {},
    onConnectionIdChange: () => {},
  },
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof PagerdutySetupDialog>

export default meta

type Story = StoryObj<typeof meta>

export const RegisterOAuthApp: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
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
}

export const ConnectAccount: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/oauth/start",
              ),
            () =>
              HttpResponse.json({
                authorizationUrl:
                  "https://identity.pagerduty.com/oauth/authorize",
              }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("heading", { name: "Connect PagerDuty" })
    const connect = body.getByRole("button", { name: "Connect PagerDuty" })
    // The modal fades in; wait until the step is visible.
    await waitFor(() => expect(connect).toBeVisible())
  },
}

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
  ...workspaceSourceChangeHandlers(addCalls),
  connectionUsageHandler([]),
]

export const AddToWorkspaces: Story = {
  name: "Add PagerDuty to Workspaces",
  render: () => dialog(),
  parameters: { msw: { handlers: { page: installedHandlers } } },
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
      body.getByRole("link", { name: "acme/docs#7" }),
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
}

export const ReplacedSetup: Story = {
  name: "Replaced setup with a config pull request",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({
            ...installedStatus,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: "https://github.com/acme/on-call/pull/4",
          }),
          ...installedHandlers.slice(1),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const notice = await body.findByText(/This setup was replaced/)
    // The modal fades in; wait until the notice is visible.
    await waitFor(() => expect(notice).toBeVisible())
    await expect(
      body.getByRole("link", { name: "configuration pull request" }),
    ).toHaveAttribute("href", "https://github.com/acme/on-call/pull/4")
  },
}
