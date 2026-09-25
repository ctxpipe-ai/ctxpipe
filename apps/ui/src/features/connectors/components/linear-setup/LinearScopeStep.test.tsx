// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  patchConfig: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: () => Promise<unknown>
    onMutate?: () => void
    onSuccess?: (result: unknown) => Promise<void> | void
    onError?: (error: Error) => void
    onSettled?: () => void
  }) => ({
    isPending: false,
    mutate: () => {
      options.onMutate?.()
      void options
        .mutationFn()
        .then((result) => options.onSuccess?.(result))
        .catch((error: Error) => options.onError?.(error))
        .finally(() => options.onSettled?.())
    },
  }),
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data:
      options.queryKey[0] === "linear-available-scopes"
        ? [
            {
              externalId: "team-1",
              type: "team",
              title: "Platform",
              teamId: "team-1",
              teamKey: "PLAT",
            },
            {
              externalId: "team-2",
              type: "team",
              title: "Product",
              teamId: "team-2",
              teamKey: "PROD",
            },
          ]
        : {
            scopes: [
              {
                externalId: "team-1",
                type: "team",
                title: "Platform",
                teamId: "team-1",
                teamKey: "PLAT",
              },
            ],
            syncTarget: null,
          },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
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

vi.mock("@/components/ui/CheckboxGroup", () => ({
  CheckboxGroup: ({
    children,
    onChange,
  }: {
    children?: ReactNode
    onChange: (value: string[]) => void
  }) => (
    <div>
      {children}
      <button type="button" onClick={() => onChange(["team:team-2"])}>
        Change selection
      </button>
    </div>
  ),
}))

vi.mock("@/components/ui/Checkbox", () => ({
  Checkbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/ui/InlineLoader", () => ({
  InlineLoader: () => null,
}))

vi.mock("../../queries/linear-connector", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../queries/linear-connector")>()
  return {
    ...actual,
    fetchLinearAvailableScopes: vi.fn(),
    fetchLinearConnectorConfig: vi.fn(),
    patchLinearConnectorConfig: (...args: unknown[]) =>
      mocks.patchConfig(...args),
  }
})

import { LinearScopeStep } from "./LinearScopeStep"

describe("LinearScopeStep", () => {
  let root: Root | null = null

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    document.body.innerHTML = ""
    vi.clearAllMocks()
  })

  it("passes a no-PR response to the wizard instead of claiming PR progress", async () => {
    mocks.patchConfig.mockResolvedValue({
      accepted: true,
      savedCount: 1,
      configPrEnqueued: false,
    })
    const onSaved = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <LinearScopeStep
          orgSlug="acme"
          connectionId="con_linear"
          onSaved={onSaved}
          onScopesSubmitted={vi.fn()}
          onSubmissionFailed={vi.fn()}
        />,
      )
    })

    const changeSelection = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Change selection")
    await act(async () => changeSelection?.click())

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save scope and create pull request",
    )
    expect(save?.disabled).toBe(false)
    await act(async () => {
      save?.click()
    })

    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(false)
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Linear scope already matches the repository configuration.",
    )
  })
})
