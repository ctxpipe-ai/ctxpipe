import { expect, it } from "vitest"
import { workspaceChatRunCapabilities } from "./tanstack-workspace-chat.js"

const mint = async (purpose: string) => `capability-for-${purpose}`

it("gives a hosted sandbox no capability: its firewall adds them", async () => {
  expect(await workspaceChatRunCapabilities("vercel", mint)).toEqual({})
})

it.each([
  "docker",
  "unsandboxed",
] as const)("gives a %s sandbox the Git capability for the credential route", async (isolation) => {
  expect(await workspaceChatRunCapabilities(isolation, mint)).toEqual({
    CTXPIPE_GIT_RUN_CAPABILITY: "capability-for-workspace-chat-git",
    CTXPIPE_OPENCODE_RUN_TOKEN: "capability-for-workspace-chat-model",
  })
})
