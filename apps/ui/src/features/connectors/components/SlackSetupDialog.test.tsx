// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock("@/components/ui/Tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <span data-slot="tooltip-trigger">{children}</span>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => children,
}))

const slackStatusState = vi.hoisted(() => ({
  repositories: [] as Array<{
    id: string
    name: string
    gitUrl: string
  }>,
  statusQueryOptions: null as {
    staleTime?: number
    refetchOnWindowFocus?: string
    refetchIntervalInBackground?: boolean
  } | null,
  channels: [
    {
      id: "C1",
      name: "engineering",
      isPrivate: false,
      isMember: true,
    },
  ],
  current: {
    isInstalled: true,
    installationStatus: "installed",
    teamName: "Acme Workspace",
    isGithubLinked: true,
    selectedChannelCount: 0,
    syncTargetConfigured: false,
    setupPhase: "draft" as "draft" | "awaiting_merge" | "sync_failed",
    pendingConfigPullUrl: null as string | null,
    pendingConfigPrCreating: false,
    oldestDays: 90,
    syncTarget: null as {
      repositoryId: string
      repositoryName: string
      branch: string
      githubConnectionId: string | null
    } | null,
    selectedChannels: [] as Array<{
      channelId: string
      name: string
      isPrivate: boolean
    }>,
  },
}))

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useQuery: (options: {
    queryKey: string[]
    staleTime?: number
    refetchOnWindowFocus?: string
    refetchIntervalInBackground?: boolean
  }) => {
    const { queryKey } = options
    if (queryKey[0] === "slack-status") {
      slackStatusState.statusQueryOptions = options
      return {
        data: slackStatusState.current,
        isError: false,
        isFetching: false,
        isPending: false,
        refetch: vi.fn(),
      }
    }
    if (queryKey[0] === "slack-channels") {
      return {
        data: slackStatusState.channels,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      }
    }
    if (queryKey[0] === "github-installation") {
      return {
        data: {
          id: "ghc_1",
          appSlug: "ctxpipe-agent",
          accountSlug: "acme",
        },
      }
    }
    if (queryKey[0] === "slack-setup-github-repos") {
      return {
        data: {
          repositories: [],
          repositorySelection: "selected",
          manageUrl:
            "https://github.com/organizations/acme/settings/installations/123",
          hasMore: false,
        },
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      }
    }
    return {
      data: slackStatusState.repositories,
      isError: false,
      isFetching: false,
    }
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}))

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children?: ReactNode
    onPress?: () => void
    isDisabled?: boolean
  }) => (
    <button type="button" disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/ComboBox", () => ({
  ComboBox: ({ label }: { label?: string }) => <div>{label}</div>,
  ComboBoxItem: ({ children }: { children?: ReactNode }) => children,
}))

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock("@/components/ui/NumberField", () => ({
  NumberField: () => null,
}))

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => null,
}))

vi.mock("@/lib/api", () => ({
  client: {
    ":orgSlug": {
      api: {
        v1: {
          repositories: {
            $get: vi
              .fn()
              .mockResolvedValue(
                new Response(JSON.stringify({ items: [] }), { status: 200 }),
              ),
          },
        },
      },
    },
  },
}))

vi.mock("../queries/atlassian-connector", () => ({
  searchGithubInstallationRepos: vi.fn().mockResolvedValue({
    repositories: [],
    repositorySelection: "selected",
    manageUrl:
      "https://github.com/organizations/acme/settings/installations/123",
    hasMore: false,
  }),
}))

vi.mock("../queries/github-connector", () => ({
  fetchGithubInstallationSummary: vi.fn().mockResolvedValue({
    id: "ghc_1",
    appSlug: "ctxpipe-agent",
    accountSlug: "acme",
  }),
  githubConnectorKeys: {
    installation: (orgSlug: string) => ["github-installation", orgSlug],
  },
}))

vi.mock("../queries/org-connections", () => ({
  orgConnectionsKeys: {
    list: (orgSlug: string) => ["org-connections", orgSlug],
  },
}))

vi.mock("../queries/slack-connector", () => ({
  fetchSlackAvailableChannels: vi.fn().mockResolvedValue([
    {
      id: "C1",
      name: "engineering",
      isPrivate: false,
      isMember: true,
    },
  ]),
  fetchSlackConnectorStatus: vi.fn().mockResolvedValue({
    isInstalled: true,
    installationStatus: "installed",
    teamName: "Acme Workspace",
    isGithubLinked: true,
    selectedChannelCount: 0,
    syncTargetConfigured: false,
    setupPhase: "draft",
    pendingConfigPullUrl: null,
    pendingConfigPrCreating: false,
    oldestDays: 90,
    syncTarget: null,
    selectedChannels: [],
  }),
  fetchSlackOAuthStart: vi.fn(),
  patchSlackConnectorConfig: vi.fn(),
  SlackOAuthNotConfiguredError: class SlackOAuthNotConfiguredError extends Error {},
  slackConnectorKeys: {
    status: (orgSlug: string) => ["slack-status", orgSlug],
    channels: (orgSlug: string) => ["slack-channels", orgSlug],
  },
}))

vi.mock("./ConnectorSetupStepper", () => ({
  ConnectorSetupStepper: () => null,
}))

vi.mock("./GitHubPrerequisiteStep", () => ({
  GitHubPrerequisiteStep: () => null,
}))

import { SlackSetupDialog } from "./SlackSetupDialog"

describe("SlackSetupDialog", () => {
  let root: Root | null = null

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    document.body.innerHTML = ""
  })

  it("keeps the selected channel when continuing to the repository step", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <SlackSetupDialog
          orgSlug="acme"
          connectionId="con_slack"
          isOpen
          onOpenChange={() => {}}
        />,
      )
    })

    const channelCheckbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    expect(channelCheckbox).not.toBeNull()
    expect(channelCheckbox?.closest(".max-h-72")?.className).not.toContain(
      "rounded",
    )
    expect(slackStatusState.statusQueryOptions).toMatchObject({
      staleTime: 0,
      refetchOnWindowFocus: "always",
      refetchIntervalInBackground: true,
    })

    await act(async () => channelCheckbox?.click())

    const continueButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Continue")
    expect(continueButton).toBeDefined()

    await act(async () => continueButton?.click())

    expect(container.textContent).toContain(
      "Select a repository for Slack content",
    )
  })

  it("explains how to enable a channel the bot has not joined", async () => {
    slackStatusState.channels = [
      {
        id: "C2",
        name: "support",
        isPrivate: false,
        isMember: false,
      },
    ]
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <SlackSetupDialog
          orgSlug="acme"
          connectionId="con_slack"
          isOpen
          onOpenChange={() => {}}
        />,
      )
    })

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    const tooltipTrigger = container.querySelector(
      '[data-slot="tooltip-trigger"]',
    )
    expect(checkbox?.disabled).toBe(true)
    expect(tooltipTrigger).not.toBeNull()
    expect(container.textContent).toContain(
      "Invite the ctxpipe bot, then refresh",
    )

    slackStatusState.channels = [
      {
        id: "C1",
        name: "engineering",
        isPrivate: false,
        isMember: true,
      },
    ]
  })

  it("offers a retry when pull request creation failed", async () => {
    Object.assign(slackStatusState.current, {
      selectedChannelCount: 1,
      syncTargetConfigured: true,
      setupPhase: "awaiting_merge",
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        branch: "main",
        githubConnectionId: "con_github",
      },
      selectedChannels: [
        {
          channelId: "C1",
          name: "engineering",
          isPrivate: false,
        },
      ],
    })

    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <SlackSetupDialog
          orgSlug="acme"
          connectionId="con_slack"
          isOpen
          onOpenChange={() => {}}
        />,
      )
    })

    expect(container.textContent).toContain("Pull request creation failed")
    expect(container.textContent).toContain("Try creating pull request again")

    Object.assign(slackStatusState.current, {
      selectedChannelCount: 0,
      syncTargetConfigured: false,
      setupPhase: "draft",
      syncTarget: null,
      selectedChannels: [],
    })
  })

  it("offers a retry when the initial content sync failed", async () => {
    Object.assign(slackStatusState.current, {
      selectedChannelCount: 1,
      syncTargetConfigured: true,
      setupPhase: "sync_failed",
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        branch: "main",
        githubConnectionId: "con_github",
      },
      selectedChannels: [
        {
          channelId: "C1",
          name: "engineering",
          isPrivate: false,
        },
      ],
    })

    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <SlackSetupDialog
          orgSlug="acme"
          connectionId="con_slack"
          isOpen
          onOpenChange={() => {}}
        />,
      )
    })

    expect(container.textContent).toContain("Slack content sync failed")
    expect(container.textContent).toContain("Retry content sync")

    Object.assign(slackStatusState.current, {
      selectedChannelCount: 0,
      syncTargetConfigured: false,
      setupPhase: "draft",
      syncTarget: null,
      selectedChannels: [],
    })
  })
})
