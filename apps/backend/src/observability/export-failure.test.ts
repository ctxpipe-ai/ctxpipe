import { createServer } from "node:net"

import { trace } from "@opentelemetry/api"
import { afterEach, describe, expect, it, vi } from "vitest"

import { parseEnv } from "../config/env.js"
import { flushEvlog, initEvlog, log } from "./logger.js"
import { initOtel, shutdownOtel } from "./otel.js"

/** A local port with no listener: a connect gets ECONNREFUSED at once. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/** The JSON lines that evlog writes to stdout while `work` runs. */
async function stdoutEvents(work: () => Promise<void>) {
  const lines: string[] = []
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
  try {
    await work()
  } finally {
    write.mockRestore()
  }
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("telemetry export to a collector that is down", () => {
  it("shuts down the trace and metric export without an error", async () => {
    const base = `http://127.0.0.1:${await closedPort()}`
    initOtel(
      parseEnv({
        ...process.env,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/v1/metrics`,
      }),
    )
    trace.getTracer("export-failure-test").startSpan("work").end()

    await expect(shutdownOtel()).resolves.toBeUndefined()
  })

  it("drops the log export with one counted error line, not one per batch", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      `http://127.0.0.1:${await closedPort()}/v1/logs`,
    )
    const consoleError = vi.spyOn(console, "error")

    const events = await stdoutEvents(async () => {
      initEvlog()
      for (let i = 0; i < 120; i++)
        log.info({ step: "export-failure-test", message: `event ${i}` })
      await flushEvlog()
    })

    const failures = events.filter((e) => e.step === "otlp.export-failed")
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      level: "error",
      signal: "logs",
      code: "ECONNREFUSED",
    })
    expect(failures[0]?.droppedEvents).toBeGreaterThan(0)
    expect(consoleError).not.toHaveBeenCalled()
  }, 30_000)
})
