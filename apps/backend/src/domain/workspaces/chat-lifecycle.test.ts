import { describe, expect, it } from "vitest"
import {
  CHAT_SANDBOX_IDLE_MS,
  chatMayPublishPullRequest,
  chatSessionBranchName,
  JOB_SANDBOX_IDLE_MS,
  mayForcePushBranch,
  nextChatPrNumber,
  quietUpdateChatBranch,
  restoreBranchAfterIdle,
  shouldDestroyChatSandbox,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"

describe("chat lifecycle", () => {
  it("names session branches and never force-pushes default", () => {
    expect(chatSessionBranchName("conv_1", 2)).toBe("ctxpipe/chat/conv_1/2")
    expect(nextChatPrNumber(null)).toBe(1)
    expect(mayForcePushBranch("ctxpipe/chat/conv_1/1", "main")).toBe(true)
    expect(mayForcePushBranch("main", "main")).toBe(false)
  })

  it("publishes a PR only on an explicit GitHub request while writable", () => {
    expect(
      chatMayPublishPullRequest({
        writeStatus: "writable",
        explicitRequest: true,
        host: "github",
      }),
    ).toBe(true)
    expect(
      chatMayPublishPullRequest({
        writeStatus: "writable",
        explicitRequest: false,
        host: "github",
      }),
    ).toBe(false)
    expect(
      chatMayPublishPullRequest({
        writeStatus: "read_only",
        explicitRequest: true,
        host: "github",
      }),
    ).toBe(false)
  })

  it("destroys chat after 30 minutes and jobs after 60", () => {
    const now = new Date("2026-08-16T12:00:00.000Z")
    expect(
      shouldDestroyChatSandbox({
        conversationDeleted: true,
        lastTurnAt: now,
        now,
      }),
    ).toBe(true)
    expect(
      shouldDestroyChatSandbox({
        conversationDeleted: false,
        lastTurnAt: new Date(now.getTime() - CHAT_SANDBOX_IDLE_MS),
        now,
      }),
    ).toBe(true)
    expect(
      shouldDestroyJobSandbox({
        desiredUrlChanged: true,
        runningOrQueued: true,
        lastJobAt: now,
        now,
      }),
    ).toBe(true)
    expect(
      shouldDestroyJobSandbox({
        desiredUrlChanged: false,
        runningOrQueued: false,
        lastJobAt: new Date(now.getTime() - JOB_SANDBOX_IDLE_MS + 1),
        now,
      }),
    ).toBe(false)
  })

  it("quietly rebases the same branch and stays stale if a published rebase fails", () => {
    expect(
      quietUpdateChatBranch({
        lastBranch: "main",
        defaultBranch: "main",
        lastBranchPublished: false,
        treeDirty: false,
        rebaseApplies: false,
      }),
    ).toEqual({ action: "reset_to_tip" })
    expect(
      quietUpdateChatBranch({
        lastBranch: "ctxpipe/chat/conv_1/1",
        defaultBranch: "main",
        lastBranchPublished: true,
        treeDirty: true,
        rebaseApplies: false,
      }),
    ).toEqual({ action: "stay_stale" })
    expect(
      restoreBranchAfterIdle({
        lastBranch: "ctxpipe/chat/conv_1/1",
        lastBranchExistsOnRemote: false,
        defaultBranch: "develop",
      }),
    ).toBe("develop")
  })
})
