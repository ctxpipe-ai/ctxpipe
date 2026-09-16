// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const listState = vi.hoisted(() => ({
  data: [] as Array<{
    id: string
    name?: string | null
    start?: string | null
    expiresAt?: string | null
  }>,
  error: null as unknown,
  isPending: false,
}))

const listMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const updateMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => {
    void queryFn()
    return {
      data: listState.data,
      error: listState.error,
      isPending: listState.isPending,
    }
  },
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn: (input: unknown) => Promise<unknown>
    onSuccess?: (result: unknown) => Promise<void> | void
  }) => ({
    mutate: (input: unknown) => {
      void mutationFn(input).then((result) => onSuccess?.(result))
    },
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    apiKey: {
      list: (...args: unknown[]) => listMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  },
}))

vi.mock("@/components/ui/GridList", () => ({
  GridList: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  GridListItem: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
}))

vi.mock("@/components/ui/Select", () => ({
  Select: ({
    children,
    selectedKey,
    onSelectionChange,
    label,
  }: {
    children?: ReactNode
    selectedKey?: string
    onSelectionChange?: (key: string) => void
    label?: string
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={selectedKey}
        onChange={(event) => onSelectionChange?.(event.target.value)}
      >
        {children}
      </select>
    </label>
  ),
  SelectItem: ({ id, children }: { id: string; children?: ReactNode }) => (
    <option value={id}>{children}</option>
  ),
}))

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock("@/components/ui/Dialog", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
}))

vi.mock("@/components/ui/AlertDialog", () => ({
  AlertDialog: ({
    title,
    children,
    onAction,
  }: {
    title: string
    children?: ReactNode
    onAction?: () => void
  }) => (
    <div>
      <h2>{title}</h2>
      <div>{children}</div>
      <button type="button" onClick={onAction}>
        Revoke key
      </button>
    </div>
  ),
}))

vi.mock("@/components/ui/TextField", () => ({
  TextField: ({
    label,
    value,
    onChange,
    placeholder,
  }: {
    label?: string
    value?: string
    onChange?: (value: string) => void
    placeholder?: string
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  ),
}))

vi.mock("@/components/ui/Form", () => ({
  Form: ({
    children,
    onSubmit,
  }: {
    children?: ReactNode
    onSubmit?: (event: { preventDefault: () => void }) => void
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit?.(event)
      }}
    >
      {children}
    </form>
  ),
}))

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onPress,
    type = "button",
  }: {
    children?: ReactNode
    onPress?: () => void
    type?: "button" | "submit"
  }) => (
    <button type={type} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
}))

import { OrganizationApiKeysCard } from "./OrganizationApiKeysCard"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("OrganizationApiKeysCard", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    listMock.mockReset()
    createMock.mockReset()
    updateMock.mockReset()
    deleteMock.mockReset()
    listState.data = [
      {
        id: "key_1",
        name: "ci-mcp",
        start: "org_abc",
        expiresAt: "2026-10-14T00:00:00.000Z",
      },
    ]
    listState.error = null
    listState.isPending = false
    listMock.mockResolvedValue({
      data: { apiKeys: listState.data },
      error: null,
    })
    createMock.mockResolvedValue({
      id: "key_new",
      key: "org_secret_once",
      name: "ci-mcp",
      start: "org_sec",
    })
    updateMock.mockResolvedValue({ id: "key_new" })
    deleteMock.mockResolvedValue({ success: true })

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("lists organisation keys with configId and organizationId", async () => {
    act(() => {
      root.render(<OrganizationApiKeysCard organizationId="org_acme" />)
    })

    expect(container.textContent).toContain("ci-mcp")
    expect(container.textContent).toContain("org_abc******")
    expect(container.textContent).not.toContain("org_secret_once")
    expect(container.textContent).toContain("CTXPIPE_API_KEY")
    expect(listMock).toHaveBeenCalledWith({
      query: { configId: "organization", organizationId: "org_acme" },
    })
  })

  it("mints a named 30-day key with configId and organizationId", async () => {
    act(() => {
      root.render(<OrganizationApiKeysCard organizationId="org_acme" />)
    })

    act(() => {
      ;[...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Create API key"))
        ?.click()
    })

    const nameInput = container.querySelector(
      'input[aria-label="Name"]',
    ) as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set
      setter?.call(nameInput, "staging-mcp")
      nameInput.dispatchEvent(new Event("input", { bubbles: true }))
      nameInput.dispatchEvent(new Event("change", { bubbles: true }))
    })

    const submit = [...container.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("type") === "submit" &&
        button.textContent?.includes("Create API key"),
    )
    await act(async () => {
      submit?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "organization",
        organizationId: "org_acme",
        name: "staging-mcp",
        expiresIn: 60 * 60 * 24 * 30,
        fetchOptions: { throw: true },
      }),
    )
    expect(updateMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain("org_secret_once")
    expect(container.textContent).toContain("shown once")
    expect(container.textContent).toContain("org_abc******")

    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Done",
    )
    act(() => {
      done?.click()
    })

    expect(container.textContent).not.toContain("org_secret_once")
    expect(container.textContent).toContain("org_abc******")
  })

  it("shows a never-expire warning and clears expiry after mint", async () => {
    act(() => {
      root.render(<OrganizationApiKeysCard organizationId="org_acme" />)
    })

    act(() => {
      ;[...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Create API key"))
        ?.click()
    })

    const expiry = container.querySelector(
      'select[aria-label="Expires"]',
    ) as HTMLSelectElement
    act(() => {
      expiry.value = "never"
      expiry.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(container.textContent).toContain("Never-expiring key")
    expect(container.textContent).toContain("CTXPIPE_API_KEY")

    const nameInput = container.querySelector(
      'input[aria-label="Name"]',
    ) as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set
      setter?.call(nameInput, "forever-mcp")
      nameInput.dispatchEvent(new Event("input", { bubbles: true }))
      nameInput.dispatchEvent(new Event("change", { bubbles: true }))
    })

    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("type") === "submit",
    )
    await act(async () => {
      submit?.click()
      await Promise.resolve()
    })

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "organization",
        organizationId: "org_acme",
        name: "forever-mcp",
        expiresIn: undefined,
      }),
    )
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: "key_new",
        configId: "organization",
        expiresIn: null,
      }),
    )
  })

  it("shows an admin-or-owner error when listing is forbidden", () => {
    listState.data = []
    listState.error = {
      status: 403,
      message: "INSUFFICIENT_API_KEY_PERMISSIONS",
    }

    act(() => {
      root.render(<OrganizationApiKeysCard organizationId="org_acme" />)
    })

    expect(container.textContent).toContain("Admin or owner required")
    expect(container.textContent).not.toContain("ci-mcp")
  })

  it("revokes a listed organisation key with configId", async () => {
    act(() => {
      root.render(<OrganizationApiKeysCard organizationId="org_acme" />)
    })

    act(() => {
      ;[...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Revoke"))
        ?.click()
    })

    await act(async () => {
      ;[...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Revoke key")
        ?.click()
      await Promise.resolve()
    })

    expect(deleteMock).toHaveBeenCalledWith({
      keyId: "key_1",
      configId: "organization",
      fetchOptions: { throw: true },
    })
  })
})
