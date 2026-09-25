import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Env, parseEnv } from "../config/env.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import {
  createMetricReader,
  forceFlushOtel,
  initOtel,
  isOtelStarted,
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
  otelMetricReader,
  parseOtelHeaders,
  shutdownOtel,
} from "./otel.js"

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 3001,
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    ...overrides,
  }
}

async function listenSink(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const server = createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

describe("otelDeploymentEnvironment", () => {
  it("uses RAILWAY_ENVIRONMENT_NAME when set", () => {
    expect(otelDeploymentEnvironment("pr-12", "production")).toBe("pr-12")
    expect(otelDeploymentEnvironment("production", "development")).toBe(
      "production",
    )
  })

  it("falls back to NODE_ENV", () => {
    expect(otelDeploymentEnvironment("", "production")).toBe("production")
    expect(otelDeploymentEnvironment(undefined, "development")).toBe(
      "development",
    )
  })
})

describe("isRailwayPrEnvironment", () => {
  it("matches Railway preview names only", () => {
    expect(isRailwayPrEnvironment("pr-1")).toBe(true)
    expect(isRailwayPrEnvironment("pr-334")).toBe(true)
    expect(isRailwayPrEnvironment("production")).toBe(false)
    expect(isRailwayPrEnvironment("pr-env")).toBe(false)
    expect(isRailwayPrEnvironment("")).toBe(false)
  })
})

describe("parseOtelHeaders", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseOtelHeaders("authorization=abc,x-foo=bar")).toEqual({
      authorization: "abc",
      "x-foo": "bar",
    })
  })

  it("returns empty object when unset", () => {
    expect(parseOtelHeaders(undefined)).toEqual({})
    expect(parseOtelHeaders("")).toEqual({})
  })
})

describe("parseEnv otel endpoints", () => {
  it("accepts traces and metrics endpoints", () => {
    const env = parseEnv({
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
    })
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/traces",
    )
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/metrics",
    )
  })
})

describe("createMetricReader", () => {
  it("uses a periodic reader outside pr environments", () => {
    const reader = createMetricReader(
      "http://127.0.0.1:9/v1/metrics",
      {},
      false,
    )
    expect(reader.constructor.name).toBe("PeriodicExportingMetricReader")
  })

  it("uses flush-on-demand in pr environments", () => {
    const reader = createMetricReader("http://127.0.0.1:9/v1/metrics", {}, true)
    expect(reader).toBeInstanceOf(FlushOnDemandMetricReader)
  })
})

describe("initOtel", () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await shutdownOtel()
  })

  it("is a no-op without a traces endpoint", async () => {
    initOtel(testEnv())
    expect(isOtelStarted()).toBe(false)
    expect(otelMetricReader()).toBeUndefined()
    await forceFlushOtel()
  })

  it("installs a flush-on-demand reader for pr-N", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-4")
    const sink = await listenSink()
    try {
      initOtel(
        testEnv({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${sink.port}/v1/traces`,
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${sink.port}/v1/metrics`,
          OTEL_SERVICE_NAME: "ctxpipe-codesearch",
        }),
      )
      expect(isOtelStarted()).toBe(true)
      expect(otelMetricReader()).toBeInstanceOf(FlushOnDemandMetricReader)
    } finally {
      await shutdownOtel()
      await sink.close()
    }
  })
})
