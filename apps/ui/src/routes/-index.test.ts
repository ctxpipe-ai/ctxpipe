import { QueryClient } from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { workspaceListOptions } from "@/features/workspaces/queries"
import { installRelativeFetch } from "@/features/workspaces/relative-fetch-test"

import { warmWorkspaceLists } from "./index"

const server = setupServer()
let restoreFetch = () => {}

describe("warmWorkspaceLists", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    restoreFetch = installRelativeFetch()
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    restoreFetch()
  })

  it("does not throw when a Workspace list read fails, so Home can show the error", async () => {
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

    await expect(warmWorkspaceLists(queryClient)).resolves.toBeUndefined()

    expect(
      queryClient.getQueryState(workspaceListOptions("acme").queryKey)?.status,
    ).toBe("error")
  })
})
