import { expect, it } from "vitest"
import type { RunVaultRule } from "./agent-vault.js"
import { workspaceChatRunCapabilities } from "./tanstack-workspace-chat.js"

const mint = async (purpose: string) => `capability-for-${purpose}`
const proxyUrl =
  "http://backend.sandbox.ctxpipe.internal:3000/acme/api/v1/workspace-chat/openai/v1"

it("gives a hosted sandbox no capability: its firewall adds them", async () => {
  expect(
    await workspaceChatRunCapabilities("vercel", undefined, proxyUrl, mint),
  ).toEqual({})
})

it("gives an unsandboxed run only the model capability", async () => {
  expect(
    await workspaceChatRunCapabilities(
      "unsandboxed",
      undefined,
      proxyUrl,
      mint,
    ),
  ).toEqual({
    CTXPIPE_OPENCODE_RUN_TOKEN: "capability-for-workspace-chat-model",
  })
})

it("keeps a Docker run's model capability in its vault and gives the sandbox a placeholder", async () => {
  const rules: RunVaultRule[] = []
  const vault = {
    addRules: async (added: RunVaultRule[]) => void rules.push(...added),
  }
  const env = await workspaceChatRunCapabilities(
    "docker",
    vault,
    proxyUrl,
    mint,
  )
  expect(env).toEqual({ CTXPIPE_OPENCODE_RUN_TOKEN: "added-by-proxy" })
  expect(JSON.stringify(env)).not.toContain("capability-for")
  const base =
    "backend.sandbox.ctxpipe.internal:3000/acme/api/v1/workspace-chat/openai/v1"
  // Exact paths only: no glob that a `..` segment could pass.
  expect(rules).toEqual([
    {
      name: "model-proxy-chat",
      host: `${base}/chat/completions`,
      bearer: "capability-for-workspace-chat-model",
    },
    {
      name: "model-proxy-models",
      host: `${base}/models`,
      bearer: "capability-for-workspace-chat-model",
    },
  ])
})
