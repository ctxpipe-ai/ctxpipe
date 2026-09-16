// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const memberRole = vi.hoisted(() => ({ value: "member" as string | null }))

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: memberRole.value }),
  useInfiniteQuery: () => ({
    isLoading: false,
    data: {
      pages: [
        {
          items: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    ...props
  }: {
    children: ReactNode
    [key: string]: unknown
  }) => <a {...props}>{children}</a>,
  useRouter: () => ({ navigate: vi.fn() }),
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: {
      getActiveMemberRole: vi.fn(),
    },
  },
}))

vi.mock("@/lib/api", () => ({
  client: {
    ":orgSlug": {
      api: {
        v1: {
          conversations: {
            $get: vi.fn(),
            ":conversationId": {
              $patch: vi.fn(),
              $delete: vi.fn(),
            },
          },
        },
      },
    },
  },
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ render }: { render?: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuRadioItem: ({
    value,
    children,
  }: {
    value: string
    children: ReactNode
  }) => <div data-filter-value={value}>{children}</div>,
}))

vi.mock("@/components/ui/GridList", () => ({
  GridList: ({ renderEmptyState }: { renderEmptyState?: () => ReactNode }) => (
    <div>{renderEmptyState?.()}</div>
  ),
  GridListItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

import { ConversationList } from "./ConversationList"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("ConversationList MCP service filter", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    memberRole.value = "member"
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("shows MCP service for an org admin", () => {
    memberRole.value = "admin"

    act(() => {
      root.render(
        <ConversationList orgSlug="acme" currentConversationId={undefined} />,
      )
    })

    expect(container.textContent).toContain("MCP service")
    expect(
      container.querySelector('[data-filter-value="mcp-service"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-filter-value="ui"]')).not.toBeNull()
    expect(container.querySelector('[data-filter-value="mcp"]')).not.toBeNull()
  })

  it("hides MCP service for a member", () => {
    memberRole.value = "member"

    act(() => {
      root.render(
        <ConversationList orgSlug="acme" currentConversationId={undefined} />,
      )
    })

    expect(container.textContent).not.toContain("MCP service")
    expect(
      container.querySelector('[data-filter-value="mcp-service"]'),
    ).toBeNull()
    expect(container.querySelector('[data-filter-value="ui"]')).not.toBeNull()
    expect(container.querySelector('[data-filter-value="mcp"]')).not.toBeNull()
  })
})
