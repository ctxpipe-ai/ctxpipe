import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"

import { atlassianCapabilitiesHandler } from "@/mocks/atlassian-handlers"

import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { InstallForgeStep } from "./InstallForgeStep"

const orgSlug = "acme"
const atlassianConnectionId = "install_step_conn"

const connectorStatusOk = HttpResponse.json({
  isLinked: true,
  isInstalled: false,
  installationStatus: null,
  setupPhase: "draft",
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  syncTarget: null,
  selectedSpaces: [],
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
})

function statusHandler() {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
        return false
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    () => connectorStatusOk,
  )
}

function provisionStatusHandler(payload: Record<string, unknown>) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.endsWith("/provision-status")) return false
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    async () => {
      await delay(50)
      return HttpResponse.json(payload)
    },
  )
}

const meta = {
  title: "Components/Connections/Atlassian/Steps/InstallForge",
  component: InstallForgeStep,
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-2">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof InstallForgeStep>

export default meta

type Story = StoryObj<typeof meta>

export const CapabilitiesLoading: Story = {
  name: "Capabilities loading (no flash)",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the install options are still loading.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler("loading"),
          statusHandler(),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/provision",
              ),
            async () =>
              HttpResponse.json(
                { accepted: true as const, workflowName: "forge-provision" },
                { status: 202 },
              ),
          ),
        ],
      },
    },
  },
}

export const ProvisionFailed: Story = {
  name: "Self-hosted provision failed",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the self-hosted provision of the app failed with an error message.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler(null),
          provisionStatusHandler({
            connectionId: atlassianConnectionId,
            provisionStatus: "failed",
            provisionErrorCode: "forge_developer_space_ensure_failed",
            userMessage:
              "Could not ensure the Developer Space — check token and email",
          }),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/provision",
              ),
            async () =>
              HttpResponse.json(
                { accepted: true as const, workflowName: "forge-provision" },
                { status: 202 },
              ),
          ),
          statusHandler(),
        ],
      },
    },
  },
}

export const HostedInstallIntentError: Story = {
  name: "Hosted marketplace — install intent POST error",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the hosted Marketplace install, where the install request fails when the user starts it.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler("https://example.com/marketplace/forge"),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () =>
              HttpResponse.json(
                {
                  error: "intent_failed",
                  message: "Server could not record install intent",
                },
                { status: 500 },
              ),
          ),
          statusHandler(),
        ],
      },
    },
  },
}

export const InstallForge: Story = {
  name: "Marketplace hosted URL",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the hosted Marketplace install link is ready for the user.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler("https://example.com/marketplace/forge"),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () => HttpResponse.json({ id: atlassianConnectionId }),
          ),
          statusHandler(),
        ],
      },
    },
  },
}

export const ProvisionSelfHosted: Story = {
  name: "Self-hosted provision form",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the self-hosted provision form, before the user starts it.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler(null),
          provisionStatusHandler({
            connectionId: atlassianConnectionId,
            provisionStatus: "idle",
            provisionErrorCode: null,
            userMessage: null,
          }),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/provision",
              ),
            async () =>
              HttpResponse.json(
                { accepted: true as const, workflowName: "forge-provision" },
                { status: 202 },
              ),
          ),
          statusHandler(),
        ],
      },
    },
  },
}

export const ProvisionRunning: Story = {
  name: "Provisioning Forge app (busy)",
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the self-hosted provision of the app is running.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler(null),
          provisionStatusHandler({
            connectionId: atlassianConnectionId,
            provisionStatus: "running",
            provisionErrorCode: null,
            userMessage: null,
          }),
          statusHandler(),
        ],
      },
    },
  },
}

export const MarketplaceInstallPending: Story = {
  render: () => (
    <InstallForgeStep
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onOpenedInstall={() => {}}
    />
  ),
  parameters: {
    review: {
      purpose:
        "Step of the Confluence setup that installs the Forge app: the hosted Marketplace install, where the install request never returns after the user starts it.",
    },
    msw: {
      handlers: {
        page: [
          atlassianCapabilitiesHandler("https://example.com/marketplace/forge"),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () => new Promise(() => {}),
          ),
          statusHandler(),
        ],
      },
    },
  },
}
