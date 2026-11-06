import { AsyncResource } from "node:async_hooks"
import { EventEmitter } from "node:events"

import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import { initLogger } from "evlog"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { recordSpans } from "../../../test/spans.js"
import {
  applyAttribution,
  contextWithAttributionBag,
} from "../../observability/attribution.js"
import { applyLogContract } from "../../observability/logContract.js"

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}))

vi.mock("falkordb", () => ({
  FalkorDB: { connect: mocks.connect },
}))

import { closeGraphDb, getGraphClient, withGraphClient } from "./client.js"

const spans = recordSpans()

class FakeFalkorDb extends EventEmitter {
  close = vi.fn(async () => undefined)
  /** A socket error, which fires in the async context that opened the socket. */
  socketError = AsyncResource.bind((error: Error) => this.emit("error", error))
  selectGraph() {
    return { query: async () => ({ data: [{ n: 1 }] }) }
  }
}

const scope = { orgId: "org_1", orgSlug: "acme" }

describe("FalkorDB shared client lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRAPH_DB_PROVIDER = "falkordb"
    mocks.connect.mockImplementation(async () => new FakeFalkorDb())
  })

  afterEach(async () => {
    await closeGraphDb()
  })

  it("reuses one connection across calls", async () => {
    await withGraphClient(scope, () =>
      getGraphClient().executeQuery("RETURN 1"),
    )
    await withGraphClient(scope, () =>
      getGraphClient().executeQuery("RETURN 1"),
    )
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })

  it("survives a dropped socket and reconnects on the next call", async () => {
    await withGraphClient(scope, () =>
      getGraphClient().executeQuery("RETURN 1"),
    )
    const first = (await mocks.connect.mock.results[0]?.value) as FakeFalkorDb

    // A sleeping or restarted FalkorDB closes the socket; the client re-emits it.
    // Without a listener this is an unhandled 'error' event and kills the process.
    expect(() =>
      first.emit("error", new Error("Socket closed unexpectedly")),
    ).not.toThrow()
    expect(first.close).toHaveBeenCalledTimes(1)

    await withGraphClient(scope, () =>
      getGraphClient().executeQuery("RETURN 1"),
    )
    expect(mocks.connect).toHaveBeenCalledTimes(2)
  })

  it("logs a later socket error without the request that opened the client", async () => {
    const events: Record<string, unknown>[] = []
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        applyLogContract(ctx.event)
        events.push(ctx.event)
      },
    })
    try {
      // A request opens the shared client, then ends.
      const request = contextWithAttributionBag(context.active()).context
      await context.with(request, () =>
        trace
          .getTracer("test")
          .startActiveSpan("mcp.tool get_related", async (span) => {
            applyAttribution({
              "request.id": "req_old",
              "enduser.id": "user_old",
              "ctxpipe.mcp.tool": "get_related",
            })
            await withGraphClient(scope, () =>
              getGraphClient().executeQuery("RETURN 1"),
            )
            span.end()
          }),
      )
      const db = (await mocks.connect.mock.results[0]?.value) as FakeFalkorDb
      db.socketError(new Error("Socket closed unexpectedly"))
      const [event] = events.filter(
        (item) => item.step === "graph.falkordb.connection",
      )
      expect(event).toMatchObject({ error: "Socket closed unexpectedly" })
      const text = JSON.stringify(event)
      for (const leaked of ["req_old", "user_old", "get_related", "traceId"])
        expect(text).not.toContain(leaked)
    } finally {
      initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    }
  })

  it("records an ERROR span when connect fails", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connect ETIMEDOUT"))
    await expect(withGraphClient(scope, async () => undefined)).rejects.toThrow(
      "connect ETIMEDOUT",
    )
    const span = spans.spanNamed("falkordb.connect")
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.events.map((event) => event.name)).toContain("exception")
  })

  it("logs a failed connect as a connection error at most once a minute", async () => {
    // One hour on, so that a failed connect of an earlier test is not in
    // the same minute. Only the clock: the span processor needs real timers.
    const start = Date.now() + 3_600_000
    vi.useFakeTimers({ now: start, toFake: ["Date"] })
    const events: Record<string, unknown>[] = []
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })
    try {
      mocks.connect.mockRejectedValue(new Error("connect ECONNREFUSED"))
      const connect = () =>
        expect(withGraphClient(scope, async () => undefined)).rejects.toThrow(
          "connect ECONNREFUSED",
        )
      const connectionErrors = () =>
        events.filter((event) => event.step === "graph.falkordb.connection")
      await connect()
      await connect()
      expect(connectionErrors()).toHaveLength(1)
      vi.setSystemTime(start + 59_000)
      await connect()
      expect(connectionErrors()).toHaveLength(1)
      vi.setSystemTime(start + 60_000)
      await connect()
      expect(connectionErrors()).toHaveLength(2)
      expect(connectionErrors()[1]).toMatchObject({
        error: "connect ECONNREFUSED",
      })
    } finally {
      initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
      vi.useRealTimers()
    }
  })
})
