import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { InstallForgeStep } from "./InstallForgeStep"

const orgSlug = "acme"
const atlassianConnectionId = "install_step_conn"

const marketplaceCapsHandler = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname.endsWith("/api/v1/capabilities") &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () =>
    HttpResponse.json({
      confluenceForgeInstallUrl: "https://example.com/marketplace/forge",
    }),
)

const provisionCapsHandler = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname.endsWith("/api/v1/capabilities") &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () => HttpResponse.json({ confluenceForgeInstallUrl: null }),
)

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
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof InstallForgeStep>

export default meta

type Story = StoryObj<typeof meta>

export const MarketplaceHostedUrl: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          marketplaceCapsHandler,
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
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          provisionCapsHandler,
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
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          provisionCapsHandler,
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
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          marketplaceCapsHandler,
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
