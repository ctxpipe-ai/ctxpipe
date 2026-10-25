import { describe, expect, it } from "vitest"

import {
  observeWorkspaceChatCompletionStream,
  workspaceChatCompletionsBaseUrl,
  workspaceChatModelProxyAdvertisedHost,
} from "./workspace-chat-model-proxy.js"

describe("workspace chat completions URL", () => {
  it("advertises loopback for unsandboxed OpenCode", () => {
    expect(workspaceChatModelProxyAdvertisedHost("unsandboxed")).toBe(
      "127.0.0.1",
    )
    expect(
      workspaceChatCompletionsBaseUrl({
        isolation: "unsandboxed",
        orgSlug: "acme",
        port: 3000,
      }),
    ).toBe("http://127.0.0.1:3000/acme/api/v1/workspace-chat/openai/v1")
  })

  it("advertises host.docker.internal for docker isolation", () => {
    expect(workspaceChatModelProxyAdvertisedHost("docker")).toBe(
      "host.docker.internal",
    )
    expect(
      workspaceChatCompletionsBaseUrl({
        isolation: "docker",
        orgSlug: "acme",
        port: 3000,
      }),
    ).toBe(
      "http://host.docker.internal:3000/acme/api/v1/workspace-chat/openai/v1",
    )
  })

  it("uses one explicit callback host for remote provider URLs", () => {
    expect(workspaceChatModelProxyAdvertisedHost("docker", "10.0.0.8")).toBe(
      "10.0.0.8",
    )
    expect(
      workspaceChatCompletionsBaseUrl({
        isolation: "railway",
        orgSlug: "acme",
        port: 3000,
        callbackHost: "backend.internal",
      }),
    ).toBe("http://backend.internal:3000/acme/api/v1/workspace-chat/openai/v1")
  })
})

function observe(usage: Record<string, unknown>) {
  const observer = observeWorkspaceChatCompletionStream()
  const chunk = { model: "m", choices: [], usage }
  observer.push(
    new TextEncoder().encode(
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    ),
  )
  observer.end()
  return observer.usage
}

describe("observeWorkspaceChatCompletionStream cost", () => {
  it("adds the provider charge to the OpenRouter fee on a bring-your-own-key call", () => {
    expect(
      observe({
        prompt_tokens: 14000,
        completion_tokens: 300,
        cost: 0.0004,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0426 },
      })?.cost,
    ).toBeCloseTo(0.043, 6)
  })

  it("keeps the reported cost when the call is not bring-your-own-key", () => {
    expect(
      observe({
        prompt_tokens: 10,
        cost: 0.0021,
        is_byok: false,
        cost_details: { upstream_inference_cost: null },
      })?.cost,
    ).toBe(0.0021)
  })
})
