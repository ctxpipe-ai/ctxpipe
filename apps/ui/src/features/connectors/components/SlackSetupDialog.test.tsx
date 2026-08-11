// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const slackStatusState = vi.hoisted(() => ({
  repositories: [] as Array<{
    id: string
    name: string
    gitUrl: string
  }>,
  statusQueryOptions: null as {
    staleTime?: number
    refetchOnWindowFocus?: string
  } | null,
  current: {
    isInstalled: true,
    installationStatus: "installed",
    teamName: "Acme Workspace",
    isGithubLinked: true,
    setupPhase: "draft" as "draft" | "live",
    syncTarget: null as {
      repositoryId: string
      repositoryName: string
      branch: string
      githubConnectionId: string | null
    } | null,
  },
}))

const patchSlackConnectorConfigMock = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: () => unknown }) => ({
    isPending: false,
    mutate: () => void options.mutationFn(),
  }),
  useQuery: (options: {
    queryKey: string[]
    staleTime?: number
    refetchOnWindowFocus?: string
    enabled?: boolean
    select?: (data: unknown) => unknown
  }) => {
    const { queryKey } = options
    if (queryKey[0] === "slack-status") {
      slackStatusState.statusQueryOptions = options
      return {
        data: slackStatusState.current,
        isError: false,
        isFetching: false,
        isPending: false,
        isEnabled: options.enabled !== false,
        refetch: vi.fn(),
      }
    }
    if (queryKey[0] === "org-connections") {
      const data = [{ id: "ghc_1", type: "github" }]
      return {
        data: options.select ? options.select(data) : data,
        isError: false,
        isFetching: false,
        isPending: false,
        isEnabled: options.enabled !== false,
      }
    }
    if (queryKey[0] === "connector-sync-target-suggestion") {
      return {
        data: null,
        isError: false,
        isFetching: false,
        isPending: false,
        isEnabled: options.enabled !== false,
      }
    }
    if (queryKey[0] === "github-installation") {
      return {
        data: {
          id: "ghc_1",
          appSlug: "ctxpipe-agent",
          accountSlug: "acme",
        },
        isError: false,
        isFetching: false,
        isPending: false,
        isEnabled: options.enabled !== false,
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
        isPending: false,
        isEnabled: options.enabled !== false,
        refetch: vi.fn(),
      }
    }
    return {
      data: slackStatusState.repositories,
      isError: false,
      isFetching: false,
      isPending: false,
      isEnabled: options.enabled !== false,
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
    installation: (orgSlug: string, connectionId?: string) => [
      "github-installation",
      orgSlug,
      connectionId ?? "default",
    ],
  },
}))

vi.mock("../queries/org-connections", () => ({
  fetchOrgConnections: vi.fn().mockResolvedValue([
    { id: "ghc_1", type: "github", createdAt: "", updatedAt: "" },
  ]),
  orgConnectionsKeys: {
    list: (orgSlug: string) => ["org-connections", orgSlug],
  },
}))

vi.mock("../queries/connector-sync-target", () => ({
  fetchSuggestedConnectorSyncTarget: vi.fn().mockResolvedValue(null),
  connectorSyncTargetKeys: {
    suggestion: (orgSlug: string) => [
      "connector-sync-target-suggestion",
      orgSlug,
    ],
  },
}))

vi.mock("../queries/slack-connector", () => ({
  fetchSlackConnectorStatus: vi.fn().mockResolvedValue({
    isInstalled: true,
    installationStatus: "installed",
    teamName: "Acme Workspace",
    isGithubLinked: true,
    setupPhase: "draft",
    syncTarget: null,
  }),
  fetchSlackOAuthStart: vi.fn(),
  patchSlackConnectorConfig: patchSlackConnectorConfigMock,
  SlackOAuthNotConfiguredError: class SlackOAuthNotConfiguredError extends Error {},
  slackConnectorKeys: {
    status: (orgSlug: string) => ["slack-status", orgSlug],
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
    slackStatusState.current = {
      isInstalled: true,
      installationStatus: "installed",
      teamName: "Acme Workspace",
      isGithubLinked: true,
      setupPhase: "draft",
      syncTarget: null,
    }
    slackStatusState.repositories = []
    patchSlackConnectorConfigMock.mockReset()
  })

  it("asks for a context repository while the connector is a draft", async () => {
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

    expect(container.textContent).toContain(
      "Select a repository for Slack content",
    )
    expect(slackStatusState.statusQueryOptions).toMatchObject({
      staleTime: 0,
      refetchOnWindowFocus: "always",
    })
  })

  it("shows capture instructions once the connector is live", async () => {
    Object.assign(slackStatusState.current, {
      setupPhase: "live",
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        branch: "main",
        githubConnectionId: "con_github",
      },
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

    expect(container.textContent).toContain("Slack is connected")
    expect(container.textContent).toContain("/invite @ctxpipe")
    expect(container.textContent).toContain("acme/context")
  })

  it("lets the user return to repository selection from the live view", async () => {
    Object.assign(slackStatusState.current, {
      setupPhase: "live",
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        branch: "main",
        githubConnectionId: "con_github",
      },
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

    const changeRepoButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Change repository")
    expect(changeRepoButton).toBeDefined()

    await act(async () => changeRepoButton?.click())

    expect(container.textContent).toContain(
      "Select a repository for Slack content",
    )
    const cancelButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    )
    expect(cancelButton).toBeDefined()
  })
})
