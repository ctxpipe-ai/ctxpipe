import { OpenAPIHono } from "@hono/zod-openapi"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { forwardToUpstream } from "./openai-upstream.js"

const origin = "http://provider.test"
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest setup at file scope.
const server = useMswServer()
function app(statuses: number[]) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set(
      "env",
      parseEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://localhost/fixture",
        AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
        MODEL_PROVIDER: "openai-like",
        MODEL_PROVIDER_API_KEY: "fixture-key",
      }),
    )
    await next()
  })
  app.post("/", (c) =>
    forwardToUpstream(
      c,
      "/v1/chat/completions",
      {},
      {
        origin,
        observe: () => {},
        onObservedComplete: (status) => statuses.push(status),
      },
    ),
  )
  return app
}

describe("model proxy completion", () => {
  it.each([
    200, 429, 502,
  ])("records the upstream status %s once", async (status) => {
    server.use(
      http.post(`${origin}/v1/chat/completions`, () =>
        HttpResponse.json({}, { status }),
      ),
    )
    const statuses: number[] = []
    const response = await app(statuses).request("/", { method: "POST" })
    await response.text()
    expect(statuses).toEqual([status])
  })
  it("records an unreachable provider", async () => {
    server.use(
      http.post(`${origin}/v1/chat/completions`, () => HttpResponse.error()),
    )
    const statuses: number[] = []
    const response = await app(statuses).request("/", { method: "POST" })
    expect(response.status).toBe(502)
    expect(statuses).toEqual([502])
  })
  it("records a stream failure", async () => {
    server.use(
      http.post(
        `${origin}/v1/chat/completions`,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fixture disconnect"))
              },
            }),
          ),
      ),
    )
    const statuses: number[] = []
    const response = await app(statuses).request("/", { method: "POST" })
    await expect(response.text()).rejects.toThrow()
    expect(statuses).toEqual([502])
  })
  it("records a client cancellation", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
    server.use(
      http.post(
        `${origin}/v1/chat/completions`,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                upstream = controller
                controller.enqueue(new TextEncoder().encode("data: first\n\n"))
              },
            }),
          ),
      ),
    )
    const statuses: number[] = []
    const response = await app(statuses).request("/", { method: "POST" })
    if (!response.body) throw new Error("Expected a response body")
    const reader = response.body.getReader()
    await reader.read()
    const canceled = reader.cancel()
    upstream?.close()
    await canceled
    expect(statuses).toEqual([499])
  })
})
