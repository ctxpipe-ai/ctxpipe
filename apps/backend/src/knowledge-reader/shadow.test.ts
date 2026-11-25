import { ClickHouseError } from "@clickhouse/client"
import { initLogger } from "evlog"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { recordSpans } from "../../test/spans.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import { EmbeddingError } from "../retrieval/embeddings/textEmbeddings.js"
import { JevError } from "../retrieval/jev/client.js"
import type { KnowledgeReader } from "./knowledge-reader.js"
import { BudgetSpentError } from "./orchestrator.js"
import { shadowKnowledgeReader } from "./shadow.js"

/*
 * The cause of a failed plane read in shadow (CTX-1645). The two readers are
 * the arguments of `shadowKnowledgeReader`: the old stack answers, and the
 * plane throws the error of one failure source. The real Postgres,
 * ClickHouse, Jev and embedding paths are in
 * `knowledge-reader.integration.test.ts`.
 */

const spans = recordSpans()
const events: Record<string, unknown>[] = []
/** A message that quotes content, as a provider error can do. */
const secret = "the private text of a customer"

const legacy: KnowledgeReader = {
  stack: "legacy",
  search: async () => ({
    hits: [
      {
        workspaceId: "ws_1",
        path: "knowledge/a.md",
        score: 0.5,
      } as Awaited<ReturnType<KnowledgeReader["search"]>>["hits"][number],
    ],
  }),
  related: async () => {
    throw new Error("not used")
  },
  graph: async () => {
    throw new Error("not used")
  },
  expand: async () => {
    throw new Error("not used")
  },
}

const failing = (error: unknown) => (): KnowledgeReader => ({
  ...legacy,
  stack: "plane",
  search: async () => {
    throw error
  },
})

const networkError = Object.assign(new Error(`connect ${secret}`), {
  code: "ECONNREFUSED",
})

describe("the shadow reader", () => {
  beforeAll(() => {
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })
  })

  beforeEach(() => {
    events.length = 0
  })

  it.each([
    [
      "a ClickHouse error",
      new ClickHouseError({ message: secret, code: "241", type: "MEMORY" }),
      "clickhouse",
      "241",
    ],
    ["a connection error", networkError, "network", "ECONNREFUSED"],
    [
      "an embedding error",
      new EmbeddingError(`Embedding request failed: HTTP 402 ${secret}`, 402),
      "embedding",
      "402",
    ],
    [
      "a Jev error",
      new JevError("http", `Jev answered 503: ${secret}`, 503),
      "jev",
      "http_503",
    ],
    [
      "a Jev error behind a tool error",
      new McpToolError("judge_unavailable", "The judge did not answer.", {
        cause: new JevError("timeout", secret),
      }),
      "jev",
      "timeout",
    ],
    [
      "the end of the time budget",
      new BudgetSpentError(secret),
      "timeout",
      undefined,
    ],
    [
      "a tool error",
      new McpToolError("unknown_ref", secret),
      "tool",
      "unknown_ref",
    ],
    ["any other error", new TypeError(secret), "unknown", "TypeError"],
  ])(
    "%s gives its kind and code, on the event and on the span, with no message",
    async (_, error, kind, code) => {
      const reader = shadowKnowledgeReader(legacy, failing(error))
      await reader.search({
        orgId: "org_1",
        workspaceIds: ["ws_1"],
        query: "who owns it",
      } as Parameters<KnowledgeReader["search"]>[0])
      await vi.waitFor(() => {
        expect(events).toHaveLength(1)
      })
      const event = events[0] as { plane: Record<string, unknown> }
      expect(event.plane.failure).toBe(kind)
      expect(event.plane.failureCode).toBe(code)
      const span = spans.spanNamed("knowledge_plane.shadow")
      expect(span?.status).toEqual({ code: 2, message: kind })
      expect(span?.attributes["ctxpipe.knowledge_plane.failure"]).toBe(kind)
      expect(span?.attributes["ctxpipe.knowledge_plane.failure_code"]).toBe(
        code,
      )
      expect(span?.events.map((item) => item.attributes)).toEqual([
        { "exception.type": kind },
      ])
      expect(
        JSON.stringify([event, span?.events, span?.attributes]),
      ).not.toContain(secret)
    },
  )
})
