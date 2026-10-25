import { EventEmitter } from "node:events"
import { SpanStatusCode } from "@opentelemetry/api"
import { initLogger } from "evlog"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recordSpans } from "../../../test/spans.js"

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
