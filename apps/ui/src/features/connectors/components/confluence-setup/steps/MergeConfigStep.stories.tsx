import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { MergeConfigStep } from "./MergeConfigStep"

const orgSlug = "acme"
const atlassianConnectionId = "merge_step_conn"

function statusHandler(body: Record<string, unknown>) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
        return false
      }
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    () => HttpResponse.json(body),
  )
}

const baseStatus = {
  isLinked: true,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  selectedSpaceCount: 1,
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
}

const meta = {
  title: "Components/Connections/Atlassian/Steps/MergeConfig",
  component: MergeConfigStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof MergeConfigStep>

export default meta

type Story = StoryObj<typeof meta>

export const CreatingPullRequest: Story = {
  name: "Creating PR",
  render: () => (
    <div className="w-full max-w-md p-2">
      <MergeConfigStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: true,
          }),
        ],
      },
    },
  },
}

export const AwaitingMergeWithPrLink: Story = {
  name: "Awaiting merge (PR link)",
  render: () => (
    <div className="w-full max-w-md p-2">
      <MergeConfigStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: "https://github.com/acme/wiki/pull/42",
            pendingConfigPrCreating: false,
          }),
        ],
      },
    },
  },
}

export const InitialSync: Story = {
  name: "Initial sync after merge",
  render: () => (
    <div className="w-full max-w-md p-2">
      <MergeConfigStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "initial_sync",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          }),
        ],
      },
    },
  },
}

export const SlowPrCreation: Story = {
  name: "Slow PR creation",
  render: () => (
    <div className="w-full max-w-md p-2">
      <MergeConfigStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          }),
        ],
      },
    },
  },
}
