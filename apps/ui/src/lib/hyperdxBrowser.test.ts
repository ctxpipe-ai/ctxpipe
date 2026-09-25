import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  readEarlyHyperDxIdentity,
  resetHyperDxPublishedAttributesForTests,
  setHyperDxGlobalAttributes,
} from "./hyperdxBrowser"
import {
  recordHyperDxQueryError,
  resetHyperDxDeferredQueryErrorsForTests,
  setHyperDxExceptionRecordingEnabled,
} from "./hyperdxQueryErrors"

describe("session identity flushes deferred query errors", () => {
  beforeEach(() => {
    resetHyperDxPublishedAttributesForTests()
  })

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
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "obs-e2e-343",
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

    expect(setGlobalAttributes).toHaveBeenCalledWith(null)
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

describe("global attribute changes", () => {
  beforeEach(() => {
    resetHyperDxPublishedAttributesForTests()
  })

  afterEach(() => {
    setGlobalAttributes.mockClear()
    resetHyperDxPublishedAttributesForTests()
  })

  it("clears user A's org before publishing user B", () => {
    setHyperDxGlobalAttributes({
      userId: "user_a",
      teamId: "org_a",
      teamName: "alpha",
    })
    setGlobalAttributes.mockClear()

    setHyperDxGlobalAttributes({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })

    expect(setGlobalAttributes).toHaveBeenNthCalledWith(1, null)
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(2, {
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
      "enduser.id": "user_b",
      "ctxpipe.org.id": "org_b",
      "ctxpipe.org.slug": "beta",
    })
    const published = setGlobalAttributes.mock.calls[1]?.[0] as Record<
      string,
      string
    >
    expect(published).not.toHaveProperty("ctxpipe.org.slug", "alpha")
    expect(published.teamId).not.toBe("org_a")
  })

  it("clears org keys when the next identity has no org", () => {
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_1",
      teamName: "obs-e2e-343",
    })
    setGlobalAttributes.mockClear()

    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })

    expect(setGlobalAttributes).toHaveBeenNthCalledWith(1, null)
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(2, {
      userId: "user_1",
      "enduser.id": "user_1",
    })
    const published = setGlobalAttributes.mock.calls[1]?.[0] as Record<
      string,
      string
    >
    expect(published).not.toHaveProperty("teamId")
    expect(published).not.toHaveProperty("teamName")
    expect(published).not.toHaveProperty("ctxpipe.org.id")
    expect(published).not.toHaveProperty("ctxpipe.org.slug")
  })

  it("round-trips an empty teamId and skips a cache entry the reader rejects", () => {
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
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    expect(readCachedHyperDxIdentity()).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    const written = store.get("ctxpipe.hyperdx.identity")

    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: undefined as unknown as string,
      teamName: "acme",
    })
    expect(store.get("ctxpipe.hyperdx.identity")).toBe(written)
    expect(readCachedHyperDxIdentity()).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    vi.unstubAllGlobals()
  })
})

describe("early identity on org routes", () => {
  beforeEach(() => {
    resetHyperDxPublishedAttributesForTests()
  })

  afterEach(() => {
    setGlobalAttributes.mockClear()
    vi.unstubAllGlobals()
  })

  it("derives teamId from the route slug and the cached org list", () => {
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
    vi.stubGlobal("window", { location: { pathname: "/beta" } })

    setHyperDxGlobalAttributes(
      {
        userId: "user_1",
        teamId: "org_a",
        teamName: "alpha",
      },
      {
        organizations: [
          { id: "org_a", slug: "alpha" },
          { id: "org_b", slug: "beta" },
        ],
      },
    )

    expect(readEarlyHyperDxIdentity("/beta")).toEqual({
      userId: "user_1",
      teamId: "org_b",
      teamName: "beta",
    })
    expect(readEarlyHyperDxIdentity("/beta/chat")).toEqual({
      userId: "user_1",
      teamId: "org_b",
      teamName: "beta",
    })
    expect(readEarlyHyperDxIdentity("/alpha")).toEqual({
      userId: "user_1",
      teamId: "org_a",
      teamName: "alpha",
    })
    expect(readEarlyHyperDxIdentity("/gamma")).toEqual({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    expect(readEarlyHyperDxIdentity("/.auth/sign-in")).toBeNull()
    expect(store.has("ctxpipe.hyperdx.identity")).toBe(false)
  })

  it("keeps teamId when the cached team name is already the route slug", () => {
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
    vi.stubGlobal("window", { location: { pathname: "/alpha" } })
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_a",
      teamName: "alpha",
    })
    expect(readEarlyHyperDxIdentity("/alpha")).toEqual({
      userId: "user_1",
      teamId: "org_a",
      teamName: "alpha",
    })
    expect(readEarlyHyperDxIdentity("/onboarding")).toEqual({
      userId: "user_1",
      teamId: "org_a",
      teamName: "alpha",
    })
  })

  it("does not keep a previous user's orgs when the user id changes", () => {
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
    vi.stubGlobal("window", { location: { pathname: "/alpha" } })
    setHyperDxGlobalAttributes(
      { userId: "user_a", teamId: "org_a", teamName: "alpha" },
      { organizations: [{ id: "org_a", slug: "alpha" }] },
    )
    setHyperDxGlobalAttributes({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })
    expect(readEarlyHyperDxIdentity("/alpha")).toEqual({
      userId: "user_b",
      teamId: "",
      teamName: "",
    })
    expect(readEarlyHyperDxIdentity("/beta")).toEqual({
      userId: "user_b",
      teamId: "org_b",
      teamName: "beta",
    })
  })
})
