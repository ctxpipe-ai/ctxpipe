import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  codeSearchMock,
  graphLookupMock,
  graphTraversalMock,
  hybridSearchMock,
  aggregateClaimsMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  codeSearchMock: vi.fn(),
  graphLookupMock: vi.fn(),
  graphTraversalMock: vi.fn(),
  hybridSearchMock: vi.fn(),
  aggregateClaimsMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}))

vi.mock("../../../retrieval/index.js", () => ({
  aggregateClaimsByPredicate: aggregateClaimsMock,
  codeSearch: codeSearchMock,
  graphLookup: graphLookupMock,
  graphTraversal: graphTraversalMock,
  hybridSearch: hybridSearchMock,
}))

vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ warn: loggerWarnMock }),
}))

import { TransientHttpError } from "../../../lib/withTransientHttpRetry.js"
import type { ConversationGraphState } from "../state.js"
import { retrievalChannelsNode } from "./retrievalChannels.js"

function codeSearchState(): ConversationGraphState {
  return {
    messages: [],
    orgId: "org_test",
    orgSlug: "test",
    query: "authentication",
    plan: {
      steps: [{ type: "code_search", params: { query: "authentication" } }],
      depthLimit: 3,
      resultLimit: 20,
    },
    objectIds: [],
    claimIds: [],
    hybridResults: [],
    codeResults: [],
    retrievalWarnings: [],
    graphNodes: [],
    traversalResults: [],
    candidates: [],
    hydratedClaims: [],
    claimAggregationResults: [],
  }
}

describe("retrievalChannelsNode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    graphLookupMock.mockResolvedValue(null)
    graphTraversalMock.mockResolvedValue({
      nodeIds: [],
      edgeClaimIds: [],
    })
    hybridSearchMock.mockResolvedValue([])
    aggregateClaimsMock.mockResolvedValue([])
  })

  it("degrades an unavailable optional code-search channel", async () => {
    codeSearchMock.mockRejectedValue(
      new TransientHttpError("transient HTTP 503", 503),
    )

    const result = await retrievalChannelsNode(codeSearchState())

    expect(result.codeResults).toEqual([])
    expect(result.retrievalWarnings).toEqual([
      expect.stringContaining("temporarily unavailable"),
    ])
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("continuing"),
      expect.objectContaining({
        step: "conversation.retrieval.code_search.degraded",
        error: "transient HTTP 503",
      }),
    )
  })

  it("preserves successful code-search results without a warning", async () => {
    codeSearchMock.mockResolvedValue([
      {
        repositoryId: "repo_test",
        repositoryName: "ctxpipe",
        zoektRepoId: 1,
        query: "authentication",
        response: {},
      },
    ])

    const result = await retrievalChannelsNode(codeSearchState())

    expect(result.codeResults).toHaveLength(1)
    expect(result.retrievalWarnings).toEqual([])
    expect(loggerWarnMock).not.toHaveBeenCalled()
  })

  it("does not hide permanent code-search failures as degraded results", async () => {
    codeSearchMock.mockRejectedValue(
      new Error("codesearch failed with status 401"),
    )

    await expect(retrievalChannelsNode(codeSearchState())).rejects.toThrow(
      "codesearch failed with status 401",
    )
    expect(loggerWarnMock).not.toHaveBeenCalled()
  })
})
