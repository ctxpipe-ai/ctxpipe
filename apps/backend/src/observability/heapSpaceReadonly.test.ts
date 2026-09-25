import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as v8 from "node:v8"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import { initOtel, shutdownOtel } from "./otel.js"
import { useHeapSpaceStatisticsReaderForTests } from "./runtimeMetrics.js"

describe("heap-space statistics are not patched", () => {
  afterEach(() => {
    useHeapSpaceStatisticsReaderForTests(undefined)
  })

  it("initOtel does not throw or replace getHeapSpaceStatistics", async () => {
    const before = v8.getHeapSpaceStatistics
    useHeapSpaceStatisticsReaderForTests(() => {
      throw new Error(
        "node:v8 getHeapSpaceStatistics is not yet implemented in Bun",
      )
    })
    const sink = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => {
      sink.listen(0, "127.0.0.1", resolve)
    })
    const port = (sink.address() as AddressInfo).port
    const env = {
      NODE_ENV: "test",
      PORT: 3000,
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    } as Env
    expect(() => initOtel(env)).not.toThrow()
    expect(v8.getHeapSpaceStatistics).toBe(before)
    await shutdownOtel()
    await new Promise<void>((resolve, reject) => {
      sink.close((err) => (err ? reject(err) : resolve()))
    })
  })
})
