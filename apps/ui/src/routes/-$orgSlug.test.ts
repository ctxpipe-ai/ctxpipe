import { QueryClient } from "@tanstack/react-query"
import { isRedirect } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { isWorkspaceConversationDocument } from "@/features/workspaces/ensure-route-data"
import { workspaceListOptions } from "@/features/workspaces/queries"
import { installRelativeFetch } from "@/features/workspaces/relative-fetch-test"
import { ApiError } from "@/lib/api-result"
import { duringServerRequest, signedInHeaders } from "@/lib/server-request-test"

import { resolveOrgGate } from "./$orgSlug"

describe("isWorkspaceConversationDocument", () => {
  it("treats a conversation URL as the stored-thread document", () => {
    expect(
      isWorkspaceConversationDocument(
        "/acme-test/ws/context/conv_00000000000000000000000000",
      ),
    ).toBe(true)
  })

  it("does not treat compose or other org pages as that document", () => {
    expect(isWorkspaceConversationDocument("/acme/ws/context")).toBe(false)
    expect(isWorkspaceConversationDocument("/acme")).toBe(false)
  })
})

const server = setupServer()
let restoreFetch = () => {}

describe("resolveOrgGate", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  it("does not throw when the Workspace list read fails, so the side nav owns the error", async () => {
    server.use(
      http.get("http://localhost:3000/.auth/api/v1/auth/get-session", () =>
        HttpResponse.json({
          session: { id: "ses_1", userId: "usr_1" },
          user: { id: "usr_1", onboardingCompletedAt: "2026-01-01T00:00:00Z" },
        }),
      ),
      http.get(
        "http://localhost:3000/.auth/api/v1/auth/organization/list",
        () => HttpResponse.json([{ id: "org_1", name: "Acme", slug: "acme" }]),
      ),
      http.get("http://localhost:3000/:orgSlug/api/v1/workspaces", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const gate = await duringServerRequest(signedInHeaders, () =>
      resolveOrgGate(queryClient, "acme"),
    )

    expect(gate.orgAccessDenied).toBe(false)
    expect(
      queryClient.getQueryState(workspaceListOptions("acme").queryKey)?.status,
    ).toBe("error")
  })

  // A fake or expired cookie in a scanner burst: the backend rate limit
  // answers the session check with 429. The error screen would answer 500.
  it("sends the request to sign-in when the backend rate-limits the session check", async () => {
    server.use(
      http.get("http://localhost:3000/.auth/api/v1/auth/*", () =>
        HttpResponse.json({ message: "Too many requests" }, { status: 429 }),
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const outcome = await duringServerRequest(signedInHeaders, () =>
      resolveOrgGate(queryClient, "acme"),
    ).catch((error: unknown) => error)

    expect(isRedirect(outcome)).toBe(true)
    expect(isRedirect(outcome) && outcome.options.to).toBe("/.auth/sign-in")
  })

  // Both gate calls go through the same Better Auth rate limit for the
  // client address: in the scanner burst, each got 429 (378 times). A 429
  // on either one would otherwise give the 500 error screen.
  it("sends the request to sign-in when only the organization list is rate-limited", async () => {
    server.use(
      http.get("http://localhost:3000/.auth/api/v1/auth/get-session", () =>
        HttpResponse.json({
          session: { id: "ses_1", userId: "usr_1" },
          user: { id: "usr_1", onboardingCompletedAt: "2026-01-01T00:00:00Z" },
        }),
      ),
      http.get(
        "http://localhost:3000/.auth/api/v1/auth/organization/list",
        () =>
          HttpResponse.json({ message: "Too many requests" }, { status: 429 }),
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const outcome = await duringServerRequest(signedInHeaders, () =>
      resolveOrgGate(queryClient, "acme"),
    ).catch((error: unknown) => error)

    expect(isRedirect(outcome) && outcome.options.to).toBe("/.auth/sign-in")
  })

  it("sends an anonymous scanner path to sign-in without a backend call", async () => {
    // No handlers: msw fails the test on any backend call.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const outcome = await duringServerRequest(
      { "x-forwarded-for": "203.0.113.10" },
      () => resolveOrgGate(queryClient, "sendform.zip"),
    ).catch((error: unknown) => error)

    expect(isRedirect(outcome) && outcome.options.to).toBe("/.auth/sign-in")
  })

  it("keeps a real backend failure an error, so the error screen shows and it logs", async () => {
    server.use(
      http.get("http://localhost:3000/.auth/api/v1/auth/*", () =>
        HttpResponse.json({ message: "Bad gateway" }, { status: 502 }),
      ),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const outcome = await duringServerRequest(signedInHeaders, () =>
      resolveOrgGate(queryClient, "acme"),
    ).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(ApiError)
    expect(outcome).toMatchObject({ status: 502 })
  })
})
