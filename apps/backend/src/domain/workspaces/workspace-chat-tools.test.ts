import { describe, expect, it } from "vitest"
import {
  EXPLORER_INPUT_SCHEMAS,
  repositoryIdFromToolArgs,
  SCIP_GRAPH_TOOL_NAMES,
  workspaceChatToolAllowed,
} from "./workspace-chat-tools.js"

describe("workspace explorer input policy", () => {
  it("allows workspace tools and rejects repositories outside the captured membership", () => {
    const repositoryId = "repo_published"
    const allowedRepositoryIds = new Set([repositoryId])
    expect(
      workspaceChatToolAllowed({
        toolName: "hybrid_search",
        args: { query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "graph_lookup",
        args: { nodeId: "kn_1" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId, query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId: "repo_unrelated", query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(false)
    expect(repositoryIdFromToolArgs({ repositoryId })).toBe(repositoryId)
  })

  it("keeps checkout selection out of model-facing SCIP schemas", () => {
    for (const name of SCIP_GRAPH_TOOL_NAMES)
      expect(EXPLORER_INPUT_SCHEMAS[name]?.properties).not.toHaveProperty(
        "checkoutKey",
      )
  })
})
