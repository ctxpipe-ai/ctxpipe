// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const oauthAppState = vi.hoisted(() => ({
  current: {
    oauthConfigured: false,
    oauthAppSaved: false,
    oauthClientId: null as string | null,
    webhookConfigured: false,
    globalNotionOAuthConfigured: false,
    callbackUrl:
      "http://localhost/api/v1/connectors/notion/oauth/callback",
    webhookUrl: "http://localhost/api/v1/webhook/notion",
  },
}))

const statusState = vi.hoisted(() => ({
  current: {
    isInstalled: false,
    installationStatus: null,
    workspaceName: null,
    isGithubLinked: false,
    selectedResourceCount: 0,
    syncTargetConfigured: false,
    setupPhase: "draft" as string,
    pendingConfigPullUrl: null,
    pendingConfigPrCreating: false,
    syncTarget: null,
  },
}))

const connectStart = vi.hoisted(() => vi.fn())
const saveOauthApp = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: () => Promise<unknown>
    onSuccess?: () => Promise<void> | void
    onError?: (error: Error) => void
  }) => ({
    isPending: false,
    error: null,
    mutate: () => {
      void options.mutationFn()
    },
    mutateAsync: async () => {
      const result = await options.mutationFn()
      await options.onSuccess?.()
      return result
    },
  }),
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const key = String(options.queryKey[0])
    if (key === "notion-oauth-app") {
      return {
        data: oauthAppState.current,
        isPending: false,
        isError: false,
        isFetching: false,
      }
    }
    if (key === "notion-connector-status") {
      return {
        data: statusState.current,
        isPending: false,
        isError: false,
        isFetching: false,
      }
    }
    if (key === "notion-connector-config") {
      return {
        data: { resources: [], syncTarget: null },
        isPending: false,
        isError: false,
        isFetching: false,
      }
    }
    return {
      data: key === "repositories" ? [] : undefined,
      isPending: false,
      isError: false,
      isFetching: false,
    }
  },
  useQueries: () => [],
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

vi.mock("@/components/ui/TextField", () => ({
  TextField: ({
    label,
    value,
    onChange,
  }: {
    label?: string
    value?: string
    onChange?: (value: string) => void
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  ),
}))

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => null,
}))

vi.mock("@/components/ui/ComboBox", () => ({
  ComboBox: ({ label }: { label?: string }) => <div>{label}</div>,
  ComboBoxItem: ({ children }: { children?: ReactNode }) => children,
}))

vi.mock("@/lib/api", () => ({
  client: {
    ":orgSlug": {
      api: {
        v1: {
          repositories: {
            $get: vi.fn().mockResolvedValue(
              new Response(JSON.stringify({ items: [] }), { status: 200 }),
            ),
          },
        },
      },
    },
  },
}))

vi.mock("../hooks/useNotionOAuthConnect", () => ({
  useNotionOAuthConnect: () => ({
    start: connectStart,
    busy: false,
  }),
}))

vi.mock("../queries/notion-connector", () => ({
  fetchNotionConnectorStatus: vi.fn(),
  fetchNotionConnectorConfig: vi.fn(),
  fetchNotionOauthApp: vi.fn(),
  saveNotionOauthApp: (...args: unknown[]) => saveOauthApp(...args),
  patchNotionConnectorConfig: vi.fn(),
  retryNotionSync: vi.fn(),
  retryNotionConfig: vi.fn(),
  searchNotionResources: vi.fn(),
  notionConnectorKeys: {
    status: (orgSlug: string, connectionId?: string) => [
      "notion-connector-status",
      orgSlug,
      connectionId ?? "default",
    ],
    config: (orgSlug: string, connectionId?: string) => [
      "notion-connector-config",
      orgSlug,
      connectionId ?? "default",
    ],
    oauthApp: (orgSlug: string, connectionId: string) => [
      "notion-oauth-app",
      orgSlug,
      connectionId,
    ],
    resources: (orgSlug: string, connectionId: string | undefined, q: string) => [
      "notion-connector-resources",
      orgSlug,
      connectionId ?? "default",
      q,
    ],
  },
}))

vi.mock("./ConnectorSetupStepper", () => ({
  ConnectorSetupStepper: () => null,
}))

vi.mock("./GitHubPrerequisiteStep", () => ({
  GitHubPrerequisiteStep: () => null,
}))

import { NotionSetupDialog } from "./NotionSetupDialog"

describe("NotionSetupDialog", () => {
  let root: Root | null = null

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    document.body.innerHTML = ""
    oauthAppState.current = {
      oauthConfigured: false,
      oauthAppSaved: false,
      oauthClientId: null,
      webhookConfigured: false,
      globalNotionOAuthConfigured: false,
      callbackUrl: "http://localhost/api/v1/connectors/notion/oauth/callback",
      webhookUrl: "http://localhost/api/v1/webhook/notion",
    }
    statusState.current.isInstalled = false
    statusState.current.setupPhase = "draft"
    connectStart.mockReset()
    saveOauthApp.mockReset()
  })

  async function renderDialog() {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <NotionSetupDialog
          orgSlug="acme"
          connectionId="con_notion"
          isOpen
          onOpenChange={() => {}}
        />,
      )
    })
    return container
  }

  it("shows the register step when neither the row nor env has an OAuth app", async () => {
    const container = await renderDialog()
    expect(container.textContent).toContain("Register Notion integration")
    expect(container.textContent).toContain("Client ID")
    expect(container.textContent).not.toContain("Event URL")
  })

  it("hides the register form when hosted env OAuth is configured", async () => {
    oauthAppState.current = {
      ...oauthAppState.current,
      oauthConfigured: true,
      globalNotionOAuthConfigured: true,
    }
    const container = await renderDialog()
    expect(container.textContent).not.toContain("Register Notion integration")
    expect(container.textContent).toContain("Connect Notion")
    const connect = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect Notion",
    )
    expect(connect).toBeDefined()
    await act(async () => connect?.click())
    expect(connectStart).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "con_notion" }),
    )
  })

  it("saves the integration then offers Connect Notion", async () => {
    saveOauthApp.mockImplementation(async () => {
      oauthAppState.current = {
        ...oauthAppState.current,
        oauthConfigured: true,
        oauthAppSaved: true,
        oauthClientId: "client_123",
        webhookUrl:
          "http://localhost/api/v1/webhook/notion?connectionId=con_notion&provisioningToken=tok",
      }
    })

    const container = await renderDialog()
    const clientId = container.querySelector(
      'input[aria-label="Client ID"]',
    ) as HTMLInputElement | null
    const clientSecret = container.querySelector(
      'input[aria-label="Client secret"]',
    ) as HTMLInputElement | null
    expect(clientId).toBeTruthy()
    expect(clientSecret).toBeTruthy()

    await act(async () => {
      const setInput = (el: HTMLInputElement, value: string) => {
        const proto = Object.getPrototypeOf(el) as {
          value?: string
        }
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value")
        descriptor?.set?.call(el, value)
        el.dispatchEvent(new Event("input", { bubbles: true }))
      }
      setInput(clientId!, "client_123")
      setInput(clientSecret!, "secret_abc")
    })

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save integration",
    )
    expect(save).toBeDefined()
    await act(async () => save?.click())

    expect(saveOauthApp).toHaveBeenCalledWith("acme", "con_notion", {
      clientId: "client_123",
      clientSecret: "secret_abc",
    })
    expect(container.textContent).toContain("Event URL")
    expect(container.textContent).toContain("provisioningToken=tok")

    const connect = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect Notion",
    )
    expect(connect).toBeDefined()
    await act(async () => connect?.click())
    expect(connectStart).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "con_notion" }),
    )
  })
})
