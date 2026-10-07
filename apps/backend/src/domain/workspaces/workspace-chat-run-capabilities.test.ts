import { expect, it } from "vitest"
import type { RunVaultRule } from "./agent-vault.js"
import { workspaceChatRunCapabilities } from "./tanstack-workspace-chat.js"

const mint = async (purpose: string) => `capability-for-${purpose}`
const proxyUrl =
  "http://backend.sandbox.ctxpipe.internal:3000/acme/api/v1/workspace-chat/openai/v1"

it("gives a hosted or unsandboxed run only the model capability", async () => {
  expect(await workspaceChatRunCapabilities(undefined, proxyUrl, mint)).toEqual(
    {
      CTXPIPE_OPENCODE_RUN_TOKEN: "capability-for-workspace-chat-model",
    },
  )
})

it("keeps a Docker run's model capability in its vault and gives the sandbox a placeholder", async () => {
  const rules: RunVaultRule[] = []
  const vault = {
    addRules: async (added: RunVaultRule[]) => void rules.push(...added),
  }
  const env = await workspaceChatRunCapabilities(vault, proxyUrl, mint)
  expect(env).toEqual({ CTXPIPE_OPENCODE_RUN_TOKEN: "added-by-proxy" })
  expect(JSON.stringify(env)).not.toContain("capability-for")
  expect(rules).toEqual([
    {
      name: "model-proxy",
      host: "backend.sandbox.ctxpipe.internal:3000/acme/api/v1/workspace-chat/openai/v1/*",
      bearer: "capability-for-workspace-chat-model",
    },
  ])
})
