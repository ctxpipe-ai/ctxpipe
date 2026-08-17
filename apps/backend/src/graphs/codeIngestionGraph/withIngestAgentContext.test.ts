import { beforeEach, describe, expect, it, vi } from "vitest"

const handlerMock = vi.hoisted(() => ({
  handleChainStart: vi.fn().mockResolvedValue(undefined),
  handleChainEnd: vi.fn().mockResolvedValue(undefined),
  handleChainError: vi.fn().mockResolvedValue(undefined),
  handleGenerationStart: vi.fn().mockResolvedValue(undefined),
  handleLLMEnd: vi.fn().mockResolvedValue(undefined),
  handleLLMError: vi.fn().mockResolvedValue(undefined),
}))
const callbackHandlerConstructorMock = vi.hoisted(() =>
  vi.fn(function MockCallbackHandler() {
    return handlerMock
  }),
)
const callbackManagerConstructorMock = vi.hoisted(() => vi.fn())
const runWithConfigMock = vi.hoisted(() =>
  vi.fn((_config: unknown, fn: () => unknown) => fn()),
)

vi.mock("@langfuse/langchain", () => ({
  CallbackHandler: callbackHandlerConstructorMock,
}))

vi.mock("@langchain/core/callbacks/manager", () => ({
  CallbackManager: callbackManagerConstructorMock,
}))

vi.mock("@langchain/core/singletons", () => ({
  AsyncLocalStorageProviderSingleton: {
    runWithConfig: runWithConfigMock,
  },
}))

import {
  runWithLangfuseContext,
  withLangfuseObservation,
} from "../../observability/langfuse.js"
import { withIngestAgentContext } from "./withIngestAgentContext.js"

describe("withIngestAgentContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reuses the active Langfuse handler and parents agent callbacks", async () => {
    const result = await runWithLangfuseContext(
      {
        sessionId: "repository-ingestion:wr_1",
        tags: ["repository-ingestion"],
        traceMetadata: {
          workflow: "repository-ingestion",
          workflowRunId: "wr_1",
          targetHash: "abc",
        },
      },
      () =>
        withLangfuseObservation(
          {
            name: "repository-ingestion.root",
            metadata: { rootId: "src", workflowStepName: "root" },
          },
          () =>
            withIngestAgentContext(
              {
                sessionId: "repository-ingestion:wr_1",
                tags: ["repository-ingestion"],
                traceMetadata: {
                  workflow: "repository-ingestion",
                  workflowRunId: "wr_1",
                  targetHash: "abc",
                },
                metadata: {
                  rootId: "src",
                  workflowStepName: "identify:src",
                },
              },
              async () => "ok",
            ),
        ),
    )

    expect(result).toBe("ok")
    expect(callbackHandlerConstructorMock).toHaveBeenCalledTimes(1)

    const rootRunId = handlerMock.handleChainStart.mock.calls[0]?.[2]
    expect(rootRunId).toEqual(expect.any(String))
    expect(callbackManagerConstructorMock).toHaveBeenCalledWith(
      rootRunId,
      expect.objectContaining({
        handlers: [handlerMock],
        inheritableHandlers: [handlerMock],
        inheritableTags: ["repository-ingestion"],
        inheritableMetadata: expect.objectContaining({
          workflow: "repository-ingestion",
          workflowRunId: "wr_1",
          targetHash: "abc",
          rootId: "src",
          workflowStepName: "identify:src",
        }),
      }),
    )
    expect(runWithConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workflowRunId: "wr_1",
          targetHash: "abc",
          rootId: "src",
          workflowStepName: "identify:src",
        }),
      }),
      expect.any(Function),
    )
  })
})
