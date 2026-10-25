import { http } from "msw"
import { describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import {
  embedQuery,
  searchKnowledge,
  vectorScanSettings,
} from "./knowledge-search.js"

describe("vectorScanSettings", () => {
  it("uses iterative scan from pgvector 0.8", () => {
    for (const version of ["0.8.0", "0.8.2", "0.9.1", "0.10.0", "1.0.0"])
      expect(vectorScanSettings(version)).toEqual({
        iterativeScan: true,
        efSearch: 100,
      })
  })

  it("raises the candidate list before pgvector 0.8", () => {
    for (const version of ["0.7.4", "0.5.1", "0.7.0"])
      expect(vectorScanSettings(version)).toEqual({
        iterativeScan: false,
        efSearch: 1000,
      })
  })

  it("treats an unreadable version as an old one", () => {
    expect(vectorScanSettings(null)).toEqual({
      iterativeScan: false,
      efSearch: 1000,
    })
    expect(vectorScanSettings("dev")).toEqual({
      iterativeScan: false,
      efSearch: 1000,
    })
  })
})

const server = useMswServer()

describe("embedQuery", () => {
  /** Embed one query and return the input that the embeddings API got. */
  async function embeddedInput(instruction?: string): Promise<unknown> {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://query-model.test/v1")
    vi.stubEnv("MODEL_EMBEDDING_NAME", "qwen3-embedding")
    if (instruction)
      vi.stubEnv("MODEL_EMBEDDING_QUERY_INSTRUCTION", instruction)
    let input: unknown
    server.use(
      http.post(
        "https://query-model.test/v1/embeddings",
        async ({ request }) => {
          input = ((await request.json()) as { input: unknown }).input
          return Response.json({
            data: [{ index: 0, embedding: Array(2000).fill(0.01) }],
          })
        },
      ),
    )
    try {
      await expect(
        embedQuery("  where is the runbook  "),
      ).resolves.toHaveLength(2000)
      return input
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it("sends the query in the instruction format when an instruction is set", async () => {
    await expect(
      embeddedInput("Given a question, retrieve the passages that answer it"),
    ).resolves.toEqual([
      "Instruct: Given a question, retrieve the passages that answer it\nQuery: where is the runbook",
    ])
  })

  it("sends the bare query when no instruction is set", async () => {
    await expect(embeddedInput()).resolves.toEqual(["where is the runbook"])
  })
})

describe("searchKnowledge deadline", () => {
  it("refuses an expired budget before it starts any search", async () => {
    await expect(
      searchKnowledge({
        orgId: "org_fixture",
        workspaceIds: ["ws_fixture"],
        query: "runbook",
        deadline: performance.now() - 1,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("aborts a slow embedding request and does not start SQL after the deadline", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://deadline-model.test/v1")
    let aborted = false
    server.use(
      http.post(
        "https://deadline-model.test/v1/embeddings",
        async ({ request }) => {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            )
          })
          return new Response(null, { status: 408 })
        },
      ),
    )
    try {
      await expect(
        searchKnowledge({
          orgId: "org_fixture",
          workspaceIds: ["ws_fixture"],
          query: "runbook",
          deadline: performance.now() + 100,
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" })
      expect(aborted).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
