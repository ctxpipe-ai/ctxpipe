import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SpanStatusCode } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { runScipIndexer } from "./scipIndexers.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => provider.register())
afterEach(() => exporter.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await provider.shutdown()
})

it("records peak memory and CPU time of each indexer process on a span", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scip-resources-"))
  const checkoutPath = join(directory, "checkout")
  const shardPath = join(directory, "shards", "go.scip")
  await mkdir(checkoutPath)
  await mkdir(join(directory, "shards"))
  vi.stubGlobal("Bun", {
    spawn: vi.fn((argv: string[]) => {
      writeFileSync(argv[argv.indexOf("--output") + 1] as string, "index")
      return {
        exited: Promise.resolve(0),
        stdout: null,
        stderr: null,
        // Bun reports maxRSS in bytes and CPU time in microseconds.
        resourceUsage: () => ({
          maxRSS: 3 * 1024 * 1024 * 1024,
          cpuTime: {
            user: 90_000_000n,
            system: 10_000_000n,
            total: 100_000_000n,
          },
        }),
      }
    }),
  })
  try {
    await runScipIndexer({ indexerId: "go", checkoutPath, shardPath })
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "scip.indexer.process")
    expect(span?.attributes).toMatchObject({
      "scip.indexer": "go",
      "process.exit.code": 0,
      "scip.process.max_rss_mb": 3072,
      "scip.process.cpu_ms": 100_000,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const usage = () => ({
  maxRSS: 1024 * 1024,
  cpuTime: { user: 1000n, system: 0n, total: 1000n },
})

async function processSpanOf(spawn: () => unknown) {
  const directory = await mkdtemp(join(tmpdir(), "scip-resources-"))
  const checkoutPath = join(directory, "checkout")
  await mkdir(checkoutPath)
  vi.stubGlobal("Bun", { spawn: vi.fn(spawn) })
  try {
    await expect(
      runScipIndexer({
        indexerId: "go",
        checkoutPath,
        shardPath: join(directory, "go.scip"),
      }),
    ).rejects.toThrow()
    return exporter
      .getFinishedSpans()
      .find((s) => s.name === "scip.indexer.process")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it("marks the process span as an error when the indexer runs out of memory", async () => {
  const span = await processSpanOf(() => ({
    exited: Promise.resolve(137),
    stdout: null,
    stderr: null,
    resourceUsage: usage,
  }))
  expect(span?.status.code).toBe(SpanStatusCode.ERROR)
  expect(span?.attributes["process.exit.code"]).toBe(137)
  expect(span?.events.map((event) => event.name)).toContain("exception")
})

it("marks the process span as an error when the indexer does not start", async () => {
  const span = await processSpanOf(() => {
    throw new Error("ENOENT: scip-go")
  })
  expect(span?.status.code).toBe(SpanStatusCode.ERROR)
  expect(span?.events.map((event) => event.name)).toContain("exception")
})
