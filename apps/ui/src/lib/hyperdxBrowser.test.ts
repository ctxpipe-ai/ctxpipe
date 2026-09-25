import { afterEach, describe, expect, it, vi } from "vitest"

const { recordException, setGlobalAttributes } = vi.hoisted(() => ({
  recordException: vi.fn(),
  setGlobalAttributes: vi.fn(),
}))

vi.mock("@hyperdx/browser", () => ({
  default: {
    recordException,
    setGlobalAttributes,
  },
}))

import {
  clearHyperDxGlobalAttributes,
  readCachedHyperDxIdentity,
  setHyperDxGlobalAttributes,
} from "./hyperdxBrowser"
import {
  recordHyperDxQueryError,
  resetHyperDxDeferredQueryErrorsForTests,
  setHyperDxExceptionRecordingEnabled,
} from "./hyperdxQueryErrors"

describe("session identity flushes deferred query errors", () => {
  afterEach(() => {
    recordException.mockClear()
    setGlobalAttributes.mockClear()
    resetHyperDxDeferredQueryErrorsForTests()
    setHyperDxExceptionRecordingEnabled(false)
  })

  it("records a buffered error only after signed-in globals are applied", () => {
    setHyperDxExceptionRecordingEnabled(true)
    const error = new Error("Invalid or expired code")
    recordHyperDxQueryError({
      source: "query",
      error,
      key: ["device-code"],
    })
    expect(recordException).not.toHaveBeenCalled()

    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })

    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })
    expect(recordException).toHaveBeenCalledTimes(1)
    expect(setGlobalAttributes.mock.invocationCallOrder[0]).toBeLessThan(
      recordException.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it("records a buffered error after globals are cleared for a signed-out session", () => {
    setHyperDxExceptionRecordingEnabled(true)
    const error = new Error("Invalid or expired code")
    recordHyperDxQueryError({
      source: "query",
      error,
      key: ["device-code"],
    })

    clearHyperDxGlobalAttributes()

    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "",
      teamId: "",
      teamName: "",
    })
    expect(recordException).toHaveBeenCalledTimes(1)
    expect(setGlobalAttributes.mock.invocationCallOrder[0]).toBeLessThan(
      recordException.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it("caches only userId, teamId, and teamName and clears them on sign-out", () => {
    const store = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })
    expect(
      JSON.parse(store.get("ctxpipe.hyperdx.identity") ?? "{}"),
    ).toMatchObject({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })
    clearHyperDxGlobalAttributes()
    expect(store.has("ctxpipe.hyperdx.identity")).toBe(false)
    vi.unstubAllGlobals()
  })

  it("does not replay a previous user's identity after the session marker changes", () => {
    const store = new Map<string, string>()
    const markers = new Map<string, string>()
    const storage = {
      getItem: (key: string) =>
        (key === "ctxpipe.hd.session" ? markers : store).get(key) ?? null,
      setItem: (key: string, value: string) => {
        ;(key === "ctxpipe.hd.session" ? markers : store).set(key, value)
      },
      removeItem: (key: string) => {
        ;(key === "ctxpipe.hd.session" ? markers : store).delete(key)
      },
    }
    vi.stubGlobal("sessionStorage", storage)
    vi.stubGlobal("localStorage", storage)
    vi.stubGlobal("window", { location: { pathname: "/acme" } })

    setHyperDxGlobalAttributes({
      userId: "user_a",
      teamId: "org_a",
      teamName: "alpha",
    })
    const previous = store.get("ctxpipe.hyperdx.identity")
    setHyperDxGlobalAttributes({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })
    expect(readCachedHyperDxIdentity()).toEqual({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })
    store.set("ctxpipe.hyperdx.identity", previous ?? "")
    expect(readCachedHyperDxIdentity()).toBeNull()

    setHyperDxGlobalAttributes({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })
    clearHyperDxGlobalAttributes()
    expect(readCachedHyperDxIdentity()).toBeNull()

    setHyperDxGlobalAttributes({
      userId: "user_a",
      teamId: "org_a",
      teamName: "alpha",
    })
    window.location.pathname = "/.auth/sign-in"
    expect(readCachedHyperDxIdentity()).toBeNull()
    expect(store.has("ctxpipe.hyperdx.identity")).toBe(false)
    vi.unstubAllGlobals()
  })
})
