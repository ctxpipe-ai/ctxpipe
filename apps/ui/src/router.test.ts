import { QueryClient } from "@tanstack/react-query"
import { createMemoryHistory, createRouter } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { retryQuery } from "./lib/api-result"
import { duringServerRequest } from "./lib/server-request-test"
import { getRouter } from "./router"
import { routeTree } from "./routeTree.gen"

describe("getRouter", () => {
  it("uses retryQuery as the QueryClient default", () => {
    const router = getRouter()
    expect(
      router.options.context.queryClient.getDefaultOptions().queries?.retry,
    ).toBe(retryQuery)
  })
})

/**
 * Loads the route tree for `path` in a server request, as the Start server
 * handler does, and returns the server result that it answers with.
 */
function serverLoad(headers: Record<string, string>, path: string) {
  return duringServerRequest(headers, async () => {
    const router = createRouter({
      routeTree,
      context: { queryClient: new QueryClient() },
      isServer: true,
      history: createMemoryHistory({ initialEntries: [path] }),
    })
    await router.load()
    // The Start handler reads this private field to answer with the redirect.
    const { _serverResult } = router as unknown as {
      _serverResult?: { type: string; redirect?: Response }
    }
    return _serverResult
  })
}

// A scanner burst on unknown paths made each server render fail and log
// "Error in renderToReadableStream".
describe("server render of a scanner path", () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  afterEach(() => {
    server.resetHandlers()
    vi.restoreAllMocks()
  })
  afterAll(() => server.close())

  it("answers 307 to sign-in with no backend call and no error log", async () => {
    // No handlers: msw fails the test on any backend call.
    const logged = vi.spyOn(console, "error")

    const result = await serverLoad(
      { cookie: "theme=dark", "x-forwarded-for": "203.0.113.10" },
      "/sendform.zip",
    )

    expect(result?.type).toBe("redirect")
    expect(result?.redirect?.status).toBe(307)
    expect(result?.redirect?.headers.get("location")).toBe("/.auth/sign-in")
    expect(logged).not.toHaveBeenCalled()
  })

  it("answers 307 to sign-in when the backend rate-limits a fake session cookie", async () => {
    server.use(
      http.get("http://localhost:3000/.auth/api/v1/auth/*", () =>
        HttpResponse.json({ message: "Too many requests" }, { status: 429 }),
      ),
    )
    const logged = vi.spyOn(console, "error")

    const result = await serverLoad(
      { cookie: "__Secure-better-auth.session_token=fake" },
      "/school.zip",
    )

    expect(result?.redirect?.status).toBe(307)
    expect(result?.redirect?.headers.get("location")).toBe("/.auth/sign-in")
    expect(logged).not.toHaveBeenCalled()
  })
})
