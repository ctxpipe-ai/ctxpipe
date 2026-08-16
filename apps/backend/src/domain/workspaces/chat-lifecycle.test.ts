import { describe, expect, it } from "vitest"
import {
  applyQuietChatUpdate,
  CHAT_SANDBOX_IDLE_MS,
  chatHeartbeatKeepsSandbox,
  chatMayPublishPullRequest,
  chatSessionBranchName,
  JOB_SANDBOX_IDLE_MS,
  lastBranchExistsOnRemote,
  mayForcePushBranch,
  nextChatPrNumber,
  planChatPullRequest,
  promptRequestsChatPullRequest,
  quietUpdateChatBranch,
  quietUpdateGitCommand,
  restoreBranchAfterIdle,
  shouldDestroyChatSandbox,
  shouldDestroyJobSandbox,
  shouldHeartbeatChatSandbox,
  treeDirtyFromPorcelain,
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
        lastBranchExistsOnRemote: lastBranchExistsOnRemote({
          lastBranch: "ctxpipe/chat/conv_1/1",
          remoteBranches: [],
        }),
        defaultBranch: "develop",
      }),
    ).toBe("develop")
    expect(
      lastBranchExistsOnRemote({
        lastBranch: null,
        remoteBranches: ["main"],
      }),
    ).toBe(false)
    expect(
      restoreBranchAfterIdle({
        lastBranch: null,
        lastBranchExistsOnRemote: false,
        defaultBranch: "main",
      }),
    ).toBe("main")
    expect(treeDirtyFromPorcelain(" M knowledge/a.md\n")).toBe(true)
    expect(treeDirtyFromPorcelain("")).toBe(false)
    expect(
      quietUpdateGitCommand({
        action: "rebase_onto_tip",
        desiredSha: "abc",
      }),
    ).toBe("git rebase abc")
  })

  it("applies a quiet reset and stays stale when rebase fails", async () => {
    await expect(
      applyQuietChatUpdate({
        decision: { action: "rebase_onto_tip" },
        desiredSha: "abc",
        exec: async () => ({ stdout: "", stderr: "conflict", exitCode: 1 }),
      }),
    ).resolves.toEqual({ applied: false, action: "stay_stale" })
    await expect(
      applyQuietChatUpdate({
        decision: { action: "reset_to_tip" },
        desiredSha: "abc",
        exec: async (command) => {
          expect(command).toBe("git reset --hard abc")
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      }),
    ).resolves.toEqual({ applied: true, action: "reset_to_tip" })
  })

  it("opens a brokered PR only after an explicit request and a captured-metadata recheck", () => {
    const fresh = {
      writeStatus: "writable",
      explicitRequest: true,
      host: "github" as const,
      defaultBranch: "main",
      capturedDefaultBranch: "main",
      capturedGeneration: 3,
      desiredGeneration: 3,
      capturedUrl: "https://github.com/acme/ws.git",
      desiredUrl: "https://github.com/acme/ws.git",
      capturedSha: "abc",
      desiredSha: "abc",
    }
    expect(planChatPullRequest(fresh)).toEqual({ publish: true })
    expect(
      planChatPullRequest({
        ...fresh,
        capturedUrl: "https://github.com/acme/other.git",
      }),
    ).toEqual({ publish: false, reason: "stale_url" })
    expect(
      planChatPullRequest({
        ...fresh,
        capturedGeneration: 2,
      }),
    ).toEqual({ publish: false, reason: "stale_generation" })
    expect(
      planChatPullRequest({
        ...fresh,
        capturedSha: "old",
      }),
    ).toEqual({ publish: false, reason: "stale_sha" })
    expect(
      planChatPullRequest({
        ...fresh,
        capturedDefaultBranch: "develop",
      }),
    ).toEqual({ publish: false, reason: "stale_default_branch" })
    expect(
      planChatPullRequest({
        ...fresh,
        explicitRequest: false,
      }),
    ).toEqual({ publish: false, reason: "not_allowed" })
  })

  it("treats an explicit open-PR phrase as a brokered request", () => {
    expect(promptRequestsChatPullRequest("please open a PR for this")).toBe(
      true,
    )
    expect(promptRequestsChatPullRequest("what files changed?")).toBe(false)
  })

  it("heartbeats only while a turn is in progress", () => {
    const now = new Date("2026-08-16T12:00:00.000Z")
    expect(
      shouldHeartbeatChatSandbox({
        turnInProgress: true,
        lastHeartbeatAt: null,
        now,
      }),
    ).toBe(true)
    expect(
      shouldHeartbeatChatSandbox({
        turnInProgress: false,
        lastHeartbeatAt: now,
        now,
      }),
    ).toBe(false)
    expect(chatHeartbeatKeepsSandbox({ turnInProgress: true })).toBe(true)
  })
})
