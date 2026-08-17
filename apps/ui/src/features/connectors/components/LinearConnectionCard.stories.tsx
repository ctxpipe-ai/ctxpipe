import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import type { LinearConnectorStatus } from "../queries/linear-connector"
import { LinearConnectionCard } from "./LinearConnectionCard"

const orgSlug = "acme"
const connectionId = "linear_story"

const connected: LinearConnectorStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
  isGithubLinked: true,
  selectedScopeCount: 4,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    githubConnectionId: "github_1",
    branch: "main",
  },
}

function statusHandler(status: LinearConnectorStatus) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
    HttpResponse.json(status),
  )
}

const meta = {
  title: "Components/Connections/Linear/ConnectionCard",
  component: LinearConnectionCard,
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  args: {
    orgSlug,
    connectionId,
    onOpenWizard: () => {},
  },
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof LinearConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const Checking: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
            await delay("infinite")
            return HttpResponse.json(connected)
          }),
        ],
      },
    },
  },
}

export const CouldntLoad: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            `/${orgSlug}/api/v1/connectors/linear/status`,
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

export const NotYetConnected: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const Connected: Story = {
  parameters: {
    msw: { handlers: { page: [statusHandler(connected)] } },
  },
}

export const SyncFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [statusHandler({ ...connected, setupPhase: "sync_failed" })],
      },
    },
  },
}

export const ConfigurationPullRequestFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [statusHandler({ ...connected, setupPhase: "config_failed" })],
      },
    },
  },
}

export const AwaitingMerge: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...connected,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: "https://github.com/acme/context/pull/42",
          }),
        ],
      },
    },
  },
}
