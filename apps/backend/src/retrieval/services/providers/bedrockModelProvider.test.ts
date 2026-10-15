import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import { bedrockModelProvider } from "./bedrockModelProvider.js"

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest owns this MSW lifecycle.
const server = useMswServer()
afterEach(() => vi.unstubAllEnvs())

describe("bedrockModelProvider", () => {
  it("retries a transient service error and throttling, and does not retry a client error", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test")
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test")
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true")
    const calls = { transient: 0, client: 0 }
    server.use(
      http.post("https://bedrock-runtime.us-east-1.amazonaws.com/*", () => {
        calls.transient += 1
        return calls.transient === 1
          ? HttpResponse.json({ message: "slow down" }, { status: 503 })
          : HttpResponse.json({
              output: { message: { content: [{ text: "ok" }] } },
            })
      }),
    )
    const provider = bedrockModelProvider({
      models: ["test-model"],
      apiKey: "",
      env: { AWS_REGION: "us-east-1" },
    })
    const options = {
      messages: [{ role: "user", content: "hello" }],
      logger: { request: vi.fn() },
    } as never
    const invoke = async () => {
      for await (const _chunk of provider.chat.chatStream(options)) {
        // Consume the adapter stream to run the provider request.
      }
    }

    await expect(invoke()).resolves.toBeUndefined()
    expect(calls.transient).toBe(2)

    let throttled = 0
    server.use(
      http.post("https://bedrock-runtime.us-east-1.amazonaws.com/*", () => {
        throttled += 1
        return throttled === 1
          ? HttpResponse.json(
              { message: "Too many requests" },
              {
                status: 429,
                headers: { "x-amzn-errortype": "ThrottlingException" },
              },
            )
          : HttpResponse.json({
              output: { message: { content: [{ text: "ok" }] } },
            })
      }),
    )
    await expect(invoke()).resolves.toBeUndefined()
    expect(throttled).toBe(2)

    server.use(
      http.post("https://bedrock-runtime.us-east-1.amazonaws.com/*", () => {
        calls.client += 1
        return HttpResponse.json({ message: "bad request" }, { status: 400 })
      }),
    )
    await expect(invoke()).rejects.toThrow()
    expect(calls.client).toBe(1)
  })
})
