import { execFile } from "node:child_process"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { type RootExec, runAsRoot } from "./ingest-root.js"
import {
  capIngestText,
  INGEST_TELEMETRY_TEXT_MAX,
  ingestErrorFields,
  startIngestModelCall,
  withIngestRunSpan,
  withIngestSpan,
} from "./ingest-telemetry.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("ingest model call telemetry", () => {
  it("records one generation span of the run, with usage and the step", () => {
    const call = startIngestModelCall(
      { runId: "run_1", shard: 3, step: "skill:repository:apis:ws_1" },
      { tier: "medium", model: "openai/gpt-5.6-terra" },
    )
    call.finish({
      status: 200,
      durationMs: 42,
      finishReason: "stop",
      responseModel: "openai/gpt-5.6-terra-2026",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 },
    })
    // A second finish does not end the span again.
    call.finish({ status: 500, durationMs: 1 })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "openai/gpt-5.6-terra",
      "ctxpipe.ingest.model_tier": "medium",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 10,
      "ctxpipe.ingest.run.id": "run_1",
      "ctxpipe.ingest.shard": "3",
      "ctxpipe.ingest.step": "skill:repository:apis:ws_1",
    })
    expect(spans[0]?.status.code).not.toBe(2)
  })

  it("holds no prompt or answer, and marks a server error", () => {
    const call = startIngestModelCall(
      { runId: "run_2", shard: 0, step: "s" },
      { tier: "fast", model: "m" },
    )
    call.finish({ status: 502, durationMs: 5 })
    const span = exporter.getFinishedSpans()[0]
    expect(Object.keys(span?.attributes ?? {})).not.toEqual(
      expect.arrayContaining(["gen_ai.input.messages"]),
    )
    expect(Object.keys(span?.attributes ?? {})).not.toEqual(
      expect.arrayContaining(["gen_ai.output.messages"]),
    )
    expect(
      Object.keys(span?.attributes ?? {}).filter((key) =>
        /input$|output$|prompt|completion/.test(key.replace(/_tokens$/, "")),
      ),
    ).toEqual([])
    expect(span?.status.code).toBe(2)
  })
})

describe("capIngestText", () => {
  it("cuts a long text and keeps a short one", () => {
    expect(capIngestText("short")).toBe("short")
    const cut = capIngestText("x".repeat(5_000))
    expect(cut.length).toBe(INGEST_TELEMETRY_TEXT_MAX + 3)
    expect(capIngestText(`${"x".repeat(5000)}last error`)).toMatch(
      /last error$/,
    )
  })
})

describe("workflow control telemetry", () => {
  it("does not mark a parked step as an error", async () => {
    const signal = new Error("private sentinel")
    signal.name = "SleepSignalError"
    await expect(
      withIngestSpan("ingestion.step", {}, async () => {
        throw signal
      }),
    ).rejects.toBe(signal)
    expect(exporter.getFinishedSpans()[0]?.status.code).not.toBe(2)
  })
  it("exports only the terminal run execution", async () => {
    const signal = new Error("private sentinel")
    signal.name = "SleepSignalError"
    await expect(
      withIngestRunSpan({}, async () => {
        throw signal
      }),
    ).rejects.toBe(signal)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    await withIngestRunSpan({}, async () => "done")
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "ingestion.run",
    ])
  })
  it("does not export an arbitrary error name or message", async () => {
    const error = new Error("private sentinel")
    error.name = "private sentinel"
    await expect(
      withIngestSpan("ingestion.step", {}, async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(
      JSON.stringify(
        exporter
          .getFinishedSpans()
          .map((s) => [s.attributes, s.status, s.events]),
      ),
    ).not.toContain("private sentinel")
  })
})

describe("the fields of a failed ingest step in a log", () => {
  it("names the error class, a system error code, and a known message start", () => {
    const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" })
    expect(ingestErrorFields(reset)).toEqual({
      errorClass: "Error",
      errorCode: "ECONNRESET",
      errorKind: "aborted",
    })
    expect(
      ingestErrorFields(
        new Error(
          "Ingest root command failed (exit -1): fatal: private sentinel",
        ),
      ),
    ).toEqual({
      errorClass: "Error",
      errorKind: "Ingest root command failed (exit -1)",
    })
    expect(ingestErrorFields(new TypeError("x"))).toEqual({
      errorClass: "TypeError",
    })
  })
  it("keeps an unknown message, an error name, and a free-form code out", () => {
    const error = Object.assign(new Error("private sentinel"), {
      name: "private sentinel",
      code: "private sentinel",
    })
    expect(JSON.stringify(ingestErrorFields(error))).not.toContain(
      "private sentinel",
    )
    expect(JSON.stringify(ingestErrorFields("private sentinel"))).not.toContain(
      "private sentinel",
    )
  })
  it("names a failed fetch and the code of its cause", () => {
    expect(
      ingestErrorFields(
        new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }),
      ),
    ).toEqual({
      errorClass: "TypeError",
      errorCode: "UND_ERR_SOCKET",
      errorKind: "fetch failed",
    })
    expect(
      ingestErrorFields(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
        }),
      ),
    ).toEqual({
      errorClass: "TypeError",
      errorCode: "ECONNRESET",
      errorKind: "fetch failed",
    })
    expect(ingestErrorFields(new TypeError("terminated"))).toEqual({
      errorClass: "TypeError",
      errorKind: "terminated",
    })
    // A free-form code on the cause stays out.
    expect(
      ingestErrorFields(
        new TypeError("fetch failed", { cause: { code: "private sentinel" } }),
      ),
    ).toEqual({ errorClass: "TypeError", errorKind: "fetch failed" })
    // Text after the known start keeps the message out.
    expect(
      ingestErrorFields(new TypeError("terminated private sentinel")),
    ).toEqual({ errorClass: "TypeError" })
  })
})

describe("the Git error head of a failed root command", () => {
  /** A proxy that answers each CONNECT with this status. */
  async function refusingProxy(status: number): Promise<Server> {
    const proxy = createServer()
    proxy.on("connect", (_req, socket) =>
      socket.end(
        `HTTP/1.1 ${status} Refused\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n`,
      ),
    )
    proxy.listen(0, "127.0.0.1")
    await once(proxy, "listening")
    return proxy
  }

  /** Real Git on this host, through `runAsRoot`, as a step runs it. */
  async function failedFetch(proxyUrl: string): Promise<unknown> {
    const root: RootExec = (script) =>
      new Promise((resolve) => {
        execFile(
          "sh",
          ["-c", script],
          {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              GIT_TERMINAL_PROMPT: "0",
              https_proxy: proxyUrl,
            },
          },
          (error, stdout, stderr) =>
            resolve({
              stdout,
              stderr,
              exitCode: error ? Number(error.code ?? 1) : 0,
            }),
        )
      })
    return runAsRoot(
      root,
      "git ls-remote https://source.invalid/private-sentinel/repo.git",
    ).catch((error: unknown) => error)
  }

  it.each([407, 429])(
    "names the proxy status %i of a CONNECT and keeps the URL out",
    async (status) => {
      const proxy = await refusingProxy(status)
      try {
        const error = await failedFetch(
          `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        )
        const fields = ingestErrorFields(error)
        expect(fields.errorKind).toBe("Ingest root command failed (exit 128)")
        // curl 8 writes the first form, an older curl the second.
        expect([
          `CONNECT tunnel failed, response ${status}`,
          `Received HTTP code ${status} from proxy after CONNECT`,
        ]).toContain(fields.errorHead)
        expect(JSON.stringify(fields)).not.toMatch(
          /private-sentinel|invalid|127\.0\.0\.1/,
        )
      } finally {
        proxy.close()
      }
    },
  )

  it("names a proxy that does not resolve, without its host", async () => {
    const fields = ingestErrorFields(
      await failedFetch("http://private-sentinel.invalid:3128"),
    )
    expect(fields.errorHead).toBe("Could not resolve proxy")
    expect(JSON.stringify(fields)).not.toContain("private-sentinel")
  })

  it("names a closed proxy port, without its address", async () => {
    const proxy = await refusingProxy(407)
    const { port } = proxy.address() as AddressInfo
    proxy.close()
    await once(proxy, "close")
    const fields = ingestErrorFields(
      await failedFetch(`http://127.0.0.1:${port}`),
    )
    expect(["Couldn't connect to server", "Connection refused"]).toContain(
      fields.errorHead,
    )
  })

  it("adds nothing for a stderr with source text", () => {
    const fieldsOf = (message: string) => ingestErrorFields(new Error(message))
    expect(
      fieldsOf(
        "Ingest root command failed (exit 1): private sentinel\nconst token = 'x'",
      ),
    ).toEqual({
      errorClass: "Error",
      errorKind: "Ingest root command failed (exit 1)",
    })
    // A known head outside the Git transport line gives no head.
    expect(
      fieldsOf(
        'Ingest root command failed (exit 1): const message = "Connection refused"',
      ).errorHead,
    ).toBeUndefined()
    // A near match (a status with four digits, a longer word) gives no head.
    expect(
      fieldsOf(
        "Ingest root command failed (exit 128): fatal: unable to access 'https://x/': CONNECT tunnel failed, response 4071",
      ).errorHead,
    ).toBeUndefined()
    expect(
      fieldsOf(
        "Ingest root command failed (exit 128): fatal: unable to access 'https://x/': Connection refusedx",
      ).errorHead,
    ).toBeUndefined()
    // A head in the URL is not the cause; the curl error after it is.
    expect(
      fieldsOf(
        "Ingest root command failed (exit 128): fatal: unable to access 'https://x/Connection refused/': CONNECT tunnel failed, response 407",
      ).errorHead,
    ).toBe("CONNECT tunnel failed, response 407")
    // Only a failed root command can have a head.
    expect(
      fieldsOf(
        "fatal: unable to access 'https://x/': CONNECT tunnel failed, response 407",
      ).errorHead,
    ).toBeUndefined()
  })
})
