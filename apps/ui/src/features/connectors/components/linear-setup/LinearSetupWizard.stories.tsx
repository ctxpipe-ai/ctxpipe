import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { workspaceSourceChangeHandlers } from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import type { LinearConnectorStatus } from "../../queries/linear-connector"
import { LinearSetupWizard } from "./LinearSetupWizard"

const orgSlug = "acme"
const connectionId = "linear_story"
const baseStatus: LinearConnectorStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
  isGithubLinked: true,
  selectedScopeCount: null,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
}

function statusHandler(status: LinearConnectorStatus) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
    HttpResponse.json(status),
  )
}

function oauthAppHandler(input: {
  globalLinearOauthConfigured: boolean
  oauthAppSaved: boolean
  oauthClientId?: string | null
}) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/oauth-app`, () =>
    HttpResponse.json({
      linearOauthConfigured:
        input.globalLinearOauthConfigured || input.oauthAppSaved,
      globalLinearOauthConfigured: input.globalLinearOauthConfigured,
      oauthCallbackUrl:
        "https://app.example.com/api/v1/integrations/linear/callback",
      linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
      linearCreateUrl: "https://linear.app/settings/api/applications/new",
      oauthAppSaved: input.oauthAppSaved,
      oauthClientId: input.oauthClientId ?? null,
    }),
  )
}

const meta = {
  title: "Components/Connections/Linear/SetupWizard",
  component: LinearSetupWizard,
  decorators: entryPageInnerDecorators,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: fn(),
    onConnectionIdChange: fn(),
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof LinearSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
            await delay("infinite")
            return HttpResponse.json(baseStatus)
          }),
        ],
      },
    },
  },
}

export const ConnectWorkspace: Story = {
  args: { connectionId: undefined },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthApp: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthAppSaved: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: true,
            oauthClientId: "lin_client",
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

const addCalls: { method: string; path: string; body: unknown }[] = []
const onOpenChange = fn()

/** After the OAuth grant, the wizard maps the connection into Workspaces. */
export const ChooseWorkspaces: Story = {
  args: { onOpenChange },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    addCalls.length = 0
    onOpenChange.mockClear()
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(body.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(add)
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      path: `/${orgSlug}/api/v1/workspaces/docs/sources`,
      body: {
        source: {
          provider: "linear",
          connectionId,
          scope: { teams: ["ENG"] },
        },
      },
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  },
}
