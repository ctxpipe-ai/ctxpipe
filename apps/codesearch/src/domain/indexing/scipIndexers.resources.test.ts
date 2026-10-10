import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { runScipIndexer } from "./scipIndexers.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => provider.register())
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
      "process.exit_code": 0,
      "process.max_rss_mb": 3072,
      "process.cpu_ms": 100_000,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
