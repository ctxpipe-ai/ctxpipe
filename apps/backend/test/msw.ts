import { HttpResponse, http, type RequestHandler } from "msw"
import { type SetupServer, setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vitest"

/**
 * Shared MSW server for a vitest file. Unhandled requests fail the test.
 * Call at file scope, then `server.use(...)` inside a test for one-off handlers.
 */
export function useMswServer(...handlers: RequestHandler[]): SetupServer {
  const server = setupServer(...handlers)
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
  })
  afterEach(() => {
    server.resetHandlers()
  })
  afterAll(() => {
    server.close()
  })
  return server
}

const repositoryGoneBody = {
  error: "Repository not found or access denied",
  code: "repository_not_found",
} as const

/** 404 for any method under `{baseUrl}/:repositoryId/*` (glob, search, files). */
export function codesearchNotFound(baseUrl: string): RequestHandler {
  const root = baseUrl.replace(/\/$/, "")
  return http.all(`${root}/:repositoryId/*`, () =>
    HttpResponse.json(repositoryGoneBody, { status: 404 }),
  )
}
