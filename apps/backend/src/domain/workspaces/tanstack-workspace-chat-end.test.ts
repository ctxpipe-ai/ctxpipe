import { defineChatMiddleware } from "@tanstack/ai"
import { expect, it, vi } from "vitest"
import {
  endWorkspaceChatTurn,
  workspaceChatLockMiddleware,
} from "./tanstack-workspace-chat.js"

const turn = () => ({
  abortRun: vi.fn(async () => {}),
  failRun: vi.fn(async (_error: unknown) => {}),
})

it("records an aborted turn as aborted even when it threw", async () => {
  const t = turn()
  await endWorkspaceChatTurn({
    turn: t,
    aborted: true,
    failure: { error: new Error("boom") },
    revoke: async () => {},
  })
  expect(t.abortRun).toHaveBeenCalledOnce()
  expect(t.failRun).not.toHaveBeenCalled()
})

it("fails a turn that threw without an abort", async () => {
  const t = turn()
  const error = new Error("boom")
  await endWorkspaceChatTurn({
    turn: t,
    aborted: false,
    failure: { error },
    revoke: async () => {},
  })
  expect(t.failRun).toHaveBeenCalledWith(error)
  expect(t.abortRun).not.toHaveBeenCalled()
})

it("revokes the tokens when the run update throws, and keeps the first error", async () => {
  const t = turn()
  t.abortRun.mockRejectedValue(new Error("update failed"))
  const revoke = vi.fn(async () => {
    throw new Error("revoke failed")
  })
  await expect(
    endWorkspaceChatTurn({ turn: t, aborted: false, revoke }),
  ).rejects.toThrow("update failed")
  expect(revoke).toHaveBeenCalledOnce()
})

it("orders persistence, then the lock, then the token revoke", () => {
  const persistence = defineChatMiddleware({ name: "persistence" })
  const lock = defineChatMiddleware({ name: "lock" })
  const names = workspaceChatLockMiddleware({
    persistence,
    lock,
    revokeGitTokens: async () => {},
  }).map((middleware) => middleware.name)
  expect(names).toEqual([
    "persistence",
    "lock",
    "workspace-chat-run-git-tokens",
  ])
})
