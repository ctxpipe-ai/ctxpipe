// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { useQueriesMock, useQueryMock } = vi.hoisted(() => ({
  useQueriesMock: vi.fn(),
  useQueryMock: vi.fn(),
}))

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
  useQueries: useQueriesMock,
  useQuery: useQueryMock,
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}))

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode
    onPress?: () => void
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/ComboBox", () => ({
  ComboBox: () => null,
  ComboBoxItem: () => null,
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
          repositories: { $get: vi.fn() },
        },
      },
    },
  },
}))

vi.mock("../queries/atlassian-connector", () => ({
  atlassianConnectorKeys: { githubRepos: () => ["github-repos"] },
  searchGithubInstallationRepos: vi.fn(),
}))

vi.mock("../queries/connector-sync-target", () => ({
  connectorSyncTargetKeys: { suggestion: () => ["suggestion"] },
  fetchSuggestedConnectorSyncTarget: vi.fn(),
}))

vi.mock("../queries/github-connector", () => ({
  fetchGithubInstallationSummary: vi.fn(),
  githubConnectorKeys: { installation: () => ["github-installation"] },
}))

vi.mock("../queries/pagerduty-connector", () => ({
  fetchPagerdutyConnectorConfig: vi.fn(),
  fetchPagerdutyConnectorStatus: vi.fn(),
  fetchPagerdutyOAuthStart: vi.fn(),
  pagerdutyConnectorKeys: {
    status: () => ["pagerduty-status"],
    config: () => ["pagerduty-config"],
    services: () => ["pagerduty-services"],
    allStatusForOrg: () => ["pagerduty-status-org"],
  },
  patchPagerdutyConnectorConfig: vi.fn(),
  retryPagerdutyConfig: vi.fn(),
  retryPagerdutySync: vi.fn(),
  searchPagerdutyServices: vi.fn(),
}))

vi.mock("./ConnectorContextRepositoryGuidance", () => ({
  CONNECTOR_CONTEXT_REPOSITORY_NAME: "ctxpipe-context",
  ConnectorContextRepositoryGuidance: () => null,
  getConnectorContextRepositoryCreateUrl: () => "https://github.com/new",
}))

vi.mock("./ConnectorSetupStepper", () => ({
  ConnectorSetupStepper: () => null,
}))

vi.mock("./GitHubPrerequisiteStep", () => ({
  GitHubPrerequisiteStep: () => null,
}))

vi.mock("./PagerdutyRegisterOauthStep", () => ({
  PagerdutyRegisterOauthStep: () => <div>Register PagerDuty OAuth app</div>,
}))

import { PagerdutySetupDialog } from "./PagerdutySetupDialog"

describe("PagerdutySetupDialog", () => {
  let root: Root | null = null

  beforeEach(() => {
    useQueriesMock.mockReset()
    useQueriesMock.mockReturnValue([])
    useQueryMock.mockReset()
    useQueryMock.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch: vi.fn(),
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    document.body.innerHTML = ""
  })

  it("opens on Connect when there is no connection yet", async () => {
    const memory = new Map<string, string>()
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => {
          memory.set(key, value)
        },
        removeItem: (key: string) => {
          memory.delete(key)
        },
      },
    })

    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <PagerdutySetupDialog
          orgSlug="acme"
          isOpen
          onOpenChange={() => {}}
          onConnectionIdChange={() => {}}
        />,
      )
    })

    expect(container.textContent).toContain("Connect PagerDuty account")
    expect(container.textContent).toContain("Connect PagerDuty")
    expect(container.textContent).not.toContain("Add connection menu")
  })

  it("does not load config or repositories for an unauthorised draft", async () => {
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey: readonly unknown[] }) => ({
        data:
          queryKey[0] === "pagerduty-status"
            ? {
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
                oauthCallbackUrl:
                  "https://app.example.com/api/v1/integrations/pagerduty/callback",
              }
            : undefined,
        isError: false,
        isFetching: false,
        isPending: false,
        refetch: vi.fn(),
      }),
    )

    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <PagerdutySetupDialog
          orgSlug="acme"
          connectionId="con_draft"
          githubConnectionIds={["con_github"]}
          isOpen
          onOpenChange={() => {}}
          onConnectionIdChange={() => {}}
        />,
      )
    })

    const queryOptions = useQueryMock.mock.calls.map(
      ([options]) =>
        options as {
          queryKey: readonly unknown[]
          enabled?: boolean
        },
    )
    expect(
      queryOptions.find(({ queryKey }) => queryKey[0] === "pagerduty-config")
        ?.enabled,
    ).toBe(false)
    expect(
      queryOptions.find(({ queryKey }) => queryKey[0] === "repositories")
        ?.enabled,
    ).toBe(false)
    expect(
      queryOptions.find(({ queryKey }) => queryKey[0] === "suggestion")
        ?.enabled,
    ).toBe(false)
    expect(
      queryOptions.find(({ queryKey }) => queryKey[0] === "github-repos")
        ?.enabled,
    ).toBe(false)
    expect(
      (
        useQueriesMock.mock.calls[0]?.[0] as {
          queries: Array<{ enabled?: boolean }>
        }
      ).queries.every(({ enabled }) => enabled === false),
    ).toBe(true)
  })
})
