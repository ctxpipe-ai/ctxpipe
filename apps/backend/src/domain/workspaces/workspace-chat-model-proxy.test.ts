import { describe, expect, it } from "vitest"
import {
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
})
