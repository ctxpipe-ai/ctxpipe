import { createMemoryHistory, isRedirect } from "@tanstack/react-router"
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
import { duringServerRequest, scannerHeaders } from "./lib/server-request-test"
import { getRouter } from "./router"

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
    const router = getRouter()
    router.update({
      ...router.options,
      isServer: true,
      history: createMemoryHistory({ initialEntries: [path] }),
    })
    await router.load()
    // The Start handler answers with this redirect before it renders.
    return router._serverResult
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

    const result = await serverLoad(scannerHeaders, "/sendform.zip")

    expect(result?.type).toBe("redirect")
    const redirect = result?.type === "redirect" ? result.redirect : undefined
    expect(isRedirect(redirect) && redirect.status).toBe(307)
    expect(redirect?.headers.get("location")).toBe("/.auth/sign-in")
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

    const redirect = result?.type === "redirect" ? result.redirect : undefined
    expect(isRedirect(redirect) && redirect.status).toBe(307)
    expect(redirect?.headers.get("location")).toBe("/.auth/sign-in")
    expect(logged).not.toHaveBeenCalled()
  })
})
