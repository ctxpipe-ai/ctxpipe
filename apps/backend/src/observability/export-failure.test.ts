import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { initLogger } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"

import { exportFailureReport } from "./exportFailures.js"

/** A local port with no listener: a connect gets ECONNREFUSED at once. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/**
 * Run `body` in a new process whose collector (all OTLP endpoints) is a
 * closed port, then write `ALIVE`. Returns the exit code, the last stdout
 * line, the evlog events on stdout, and stderr.
 */
async function runWithCollectorDown(body: string, env: NodeJS.ProcessEnv = {}) {
  const base = `http://127.0.0.1:${await closedPort()}`
  const script = `
import { trace } from "@opentelemetry/api"
import { parseEnv } from "./src/config/env.ts"
import { flushEvlog, initEvlog, log } from "./src/observability/logger.ts"
import { forceFlushOtel, initOtel, shutdownOtel } from "./src/observability/otel.ts"
${body}
process.stdout.write("ALIVE\\n")
`
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/v1/metrics`,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
        ...env,
      },
    },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += String(chunk)))
  child.stderr.on("data", (chunk) => (stderr += String(chunk)))
  const [code] = await once(child, "exit")
  const lines = stdout.split("\n").filter(Boolean)
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  const failures = (signal: string) =>
    events.filter((e) => e.step === "otlp.export-failed" && e.signal === signal)
  return { code, lastLine: lines.at(-1), events, failures, stderr }
}

describe("telemetry export to a collector that is down", () => {
  it("drops the log export with one counted error line, and the process stays up", async () => {
    const run = await runWithCollectorDown(`
initEvlog()
for (let i = 0; i < 120; i++) log.info({ step: "export-failure-test", message: "event " + i })
await flushEvlog()
`)

    expect(run.code).toBe(0)
    expect(run.lastLine).toBe("ALIVE")
    expect(run.failures("logs")).toHaveLength(1)
    expect(run.failures("logs")[0]).toMatchObject({
      level: "error",
      code: "ECONNREFUSED",
      failedExports: 1,
    })
    expect(run.failures("logs")[0]?.droppedEvents).toBeGreaterThan(0)
    expect(run.stderr).not.toContain("Failed to send events")
  }, 60_000)

  it("flushes and shuts down the trace and metric export with one error line, and the process stays up", async () => {
    // A preview flushes after each response or job, so a down collector
    // fails each flush.
    const run = await runWithCollectorDown(
      `
initEvlog()
initOtel(parseEnv(process.env))
for (let i = 0; i < 3; i++) {
  trace.getTracer("export-failure-test").startSpan("work").end()
  await forceFlushOtel()
}
await shutdownOtel()
`,
      { DEPLOYMENT_ENVIRONMENT: "pr-1", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "" },
    )

    expect(run.code).toBe(0)
    expect(run.lastLine).toBe("ALIVE")
    expect(run.failures("traces and metrics")).toHaveLength(1)
    expect(run.failures("traces and metrics")[0]).toMatchObject({
      level: "error",
      code: "ECONNREFUSED",
      failedExports: 1,
    })
    expect(run.events.filter((e) => e.step === "otel.flush")).toEqual([])
  }, 60_000)
})

describe("export failure report", () => {
  afterEach(() => {
    vi.useRealTimers()
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  })

  it("logs once a minute, with the failures and drops since the last line", () => {
    vi.useFakeTimers()
    const events: Record<string, unknown>[] = []
    initLogger({
      env: { service: "test" },
      silent: true,
      drain: (ctx) => void events.push(ctx.event),
    })
    const report = exportFailureReport("logs")

    report(new Error("down"), 50)
    report(new Error("down"), 50)
    report(new Error("down"), 20)
    vi.advanceTimersByTime(61_000)
    report(new Error("down"), 5)

    expect(
      events
        .filter((e) => e.step === "otlp.export-failed")
        .map((e) => [e.failedExports, e.droppedEvents]),
    ).toEqual([
      [1, 50],
      [3, 75],
    ])
  })
})
