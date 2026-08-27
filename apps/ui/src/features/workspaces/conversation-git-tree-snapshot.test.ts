import { afterEach, describe, expect, it } from "vitest"
import {
  clearAllConversationGitTreeSnapshots,
  readConversationGitTreeSnapshot,
  writeConversationGitTreeSnapshot,
} from "./conversation-git-tree-snapshot"

describe("conversation git tree snapshot", () => {
  afterEach(() => {
    clearAllConversationGitTreeSnapshots()
  })

  it("round-trips the last sandbox tree", () => {
    writeConversationGitTreeSnapshot("conv_1", {
      sha: "abc",
      branch: "ctxpipe/chat/conv_1/1",
      paths: ["AGENTS.md", "e2e.md"],
    })
    expect(readConversationGitTreeSnapshot("conv_1")).toEqual({
      sha: "abc",
      branch: "ctxpipe/chat/conv_1/1",
      paths: ["AGENTS.md", "e2e.md"],
    })
    expect(readConversationGitTreeSnapshot("conv_other")).toBeUndefined()
  })

  it("ignores corrupt session entries", () => {
    sessionStorage.setItem("ctxpipe.conversation-git-tree.conv_1", "{")
    expect(readConversationGitTreeSnapshot("conv_1")).toBeUndefined()
  })
})
