import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  applyConversationFileWriteSnapshot,
  conversationWorktreeVersionFromCache,
  resolveConversationWorktreeVersion,
  workspaceKeys,
} from "./queries"
import type { ConversationFileWriteResponse } from "./types"

function snapshot(
  version: string,
  body: string,
): ConversationFileWriteResponse {
  return {
    path: "notes.md",
    body,
    binary: false,
    worktreeVersion: version,
    tree: {
      sha: "HEAD",
      paths: ["notes.md"],
      branch: "ctxpipe/chat/conv_1/1",
      worktreeVersion: version,
    },
    status: {
      source: "sandbox",
      branch: "ctxpipe/chat/conv_1/1",
      dirty: true,
      differsFromDefault: true,
      unpushed: true,
      published: false,
      ahead: 0,
      behind: 0,
      items: [{ path: "notes.md", status: "modified" }],
      worktreeVersion: version,
    },
  }
}

describe("conversation file write snapshots", () => {
  it("applies the authoritative tree, status, and blob", () => {
    const client = new QueryClient()
    applyConversationFileWriteSnapshot(
      client,
      "acme",
      "conv_1",
      snapshot("v1", "hello"),
    )
    expect(conversationWorktreeVersionFromCache(client, "acme", "conv_1")).toBe(
      "v1",
    )
    expect(
      client.getQueryData(
        workspaceKeys.conversationGitBlob("acme", "conv_1", "notes.md"),
      ),
    ).toMatchObject({ body: "hello" })
  })

  it("ignores a late snapshot whose base version was already replaced", () => {
    const client = new QueryClient()
    applyConversationFileWriteSnapshot(
      client,
      "acme",
      "conv_1",
      snapshot("v2", "second"),
    )
    applyConversationFileWriteSnapshot(
      client,
      "acme",
      "conv_1",
      snapshot("v1", "first"),
      "v0",
    )
    expect(conversationWorktreeVersionFromCache(client, "acme", "conv_1")).toBe(
      "v2",
    )
    expect(
      client.getQueryData(
        workspaceKeys.conversationGitBlob("acme", "conv_1", "notes.md"),
      ),
    ).toMatchObject({ body: "second" })
  })

  it("resolves a cached worktree version without fetching", async () => {
    const client = new QueryClient()
    client.setQueryData(workspaceKeys.conversationGitTree("acme", "conv_1"), {
      sha: "HEAD",
      paths: ["notes.md"],
      worktreeVersion: "v9",
    })
    await expect(
      resolveConversationWorktreeVersion(client, "acme", "conv_1"),
    ).resolves.toBe("v9")
  })
})
