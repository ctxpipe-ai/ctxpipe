import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../test/msw.js"
import { parseEnv } from "../config/env.js"
import {
  hyperdxSearchUrl,
  langfuseSessionUrl,
  openRouterKey,
  readLangfuseProjectId,
  readOpenRouterKeyUsage,
  readRepositoryLlmUsage,
  waitForLangfuseIngestion,
} from "./ingestionValidatorTelemetry.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const langfuse = {
  baseUrl: "https://langfuse.example.test",
  authString: Buffer.from("pk-lf:sk-lf").toString("base64"),
}
const metricsUrl = "https://langfuse.example.test/api/public/metrics"

function env(values: Record<string, string>) {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    AUTH_SECRET: "x".repeat(32),
    ...values,
  })
}

describe("OpenRouter key usage", () => {
  it("reads the key only when chat calls go to OpenRouter", () => {
    expect(openRouterKey(env({ MODEL_PROVIDER_API_KEY: "sk-or" }))).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or",
    })
    expect(
      openRouterKey(
        env({
          MODEL_PROVIDER_API_KEY: "sk-or",
          MODEL_PROVIDER_URL: "https://llm.internal.example/v1",
        }),
      ),
    ).toBeNull()
    expect(
      openRouterKey(
        env({ MODEL_PROVIDER: "bedrock", MODEL_PROVIDER_API_KEY: "sk" }),
      ),
    ).toBeNull()
    expect(openRouterKey(env({}))).toBeNull()
  })

  it("reads usage and the credit limit of the key", async () => {
    let auth: string | null = null
    server.use(
      http.get("https://openrouter.ai/api/v1/key", ({ request }) => {
        auth = request.headers.get("authorization")
        return HttpResponse.json({
          data: { label: "validator", usage: 4.25, limit: 30 },
        })
      }),
    )
    await expect(
      readOpenRouterKeyUsage({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
      }),
    ).resolves.toEqual({ usage: 4.25, limit: 30 })
    expect(auth).toBe("Bearer sk-or-test")
  })

  it("fails when OpenRouter rejects the key", async () => {
    server.use(
      http.get("https://openrouter.ai/api/v1/key", () =>
        HttpResponse.json({ error: "no" }, { status: 401 }),
      ),
    )
    await expect(
      readOpenRouterKeyUsage({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
      }),
    ).rejects.toThrow("OpenRouter key lookup failed: 401")
  })
})

describe("Langfuse usage", () => {
  it("sums generations per stage, embeddings included, and the models they used", async () => {
    const queries: Array<{
      filters: Array<Record<string, string>>
      dimensions: Array<{ field: string }>
    }> = []
    let auth: string | null = null
    server.use(
      http.get(metricsUrl, ({ request }) => {
        auth = request.headers.get("authorization")
        const query = JSON.parse(
          new URL(request.url).searchParams.get("query") ?? "{}",
        )
        queries.push(query)
        const embeddings = query.filters.some(
          (filter: Record<string, string>) => filter.column === "name",
        )
        return HttpResponse.json({
          data: embeddings
            ? [
                {
                  providedModelName: "openai/text-embedding-3-large",
                  count_count: "4",
                  sum_inputTokens: "800",
                  sum_outputTokens: "0",
                  sum_totalTokens: "800",
                  sum_totalCost: "0.0001",
                },
              ]
            : [
                {
                  providedModelName: "openai/gpt-6-luna",
                  count_count: 2,
                  sum_inputTokens: 100,
                  sum_outputTokens: 20,
                  sum_totalTokens: 120,
                  sum_totalCost: 0.00002,
                },
              ],
        })
      }),
    )
    const usage = await readRepositoryLlmUsage(langfuse, {
      repositoryId: "repo_1",
      requestId: "val_1",
      from: "2026-10-03T10:00:00.000Z",
      to: "2026-10-03T11:00:00.000Z",
    })
    expect(auth).toBe(`Basic ${langfuse.authString}`)
    expect(Object.keys(usage.stages)).toEqual([
      "identify-roots",
      "extract-kind",
      "identify",
      "embeddings",
    ])
    expect(usage.stages.embeddings).toEqual({
      calls: 4,
      inputTokens: 800,
      outputTokens: 0,
      totalTokens: 800,
      costUsd: 0.0001,
    })
    expect(usage.total).toMatchObject({ calls: 10, totalTokens: 1160 })
    expect(usage.total.costUsd).toBeCloseTo(0.00016)
    expect(usage.models).toEqual({
      "openai/gpt-6-luna": 6,
      "openai/text-embedding-3-large": 4,
    })
    expect(queries[1]?.dimensions).toEqual([{ field: "providedModelName" }])
    expect(queries[1]?.filters).toEqual([
      { column: "type", operator: "=", value: "GENERATION", type: "string" },
      {
        column: "metadata",
        operator: "=",
        key: "repositoryId",
        value: "repo_1",
        type: "stringObject",
      },
      {
        column: "metadata",
        operator: "starts with",
        key: "workflowStepName",
        value: "extract-kind:",
        type: "stringObject",
      },
    ])
    expect(queries[3]?.filters).toContainEqual({
      column: "metadata",
      operator: "=",
      key: "requestId",
      value: "val_1",
      type: "stringObject",
    })
  })

  it("waits until the run's generation count stops changing", async () => {
    const counts = [3, 7, 7]
    server.use(
      http.get(metricsUrl, () =>
        HttpResponse.json({ data: [{ count_count: counts.shift() ?? 7 }] }),
      ),
    )
    await expect(
      waitForLangfuseIngestion(langfuse, {
        requestId: "val_1",
        from: "2026-10-03T10:00:00.000Z",
        intervalMs: 1,
      }),
    ).resolves.toBe(7)
    expect(counts).toEqual([])
  })

  it("stops waiting at the bound even while counts still change", async () => {
    let calls = 0
    server.use(
      http.get(metricsUrl, () =>
        HttpResponse.json({ data: [{ count_count: ++calls }] }),
      ),
    )
    await waitForLangfuseIngestion(langfuse, {
      requestId: "val_1",
      from: "2026-10-03T10:00:00.000Z",
      intervalMs: 1,
      maxWaitMs: 0,
    })
    expect(calls).toBe(1)
  })

  it("reads the project id for session links", async () => {
    server.use(
      http.get("https://langfuse.example.test/api/public/projects", () =>
        HttpResponse.json({ data: [{ id: "proj_1", name: "ctxpipe" }] }),
      ),
    )
    await expect(readLangfuseProjectId(langfuse)).resolves.toBe("proj_1")
    expect(
      langfuseSessionUrl({
        baseUrl: "https://langfuse.example.test/",
        projectId: "proj_1",
        repositoryIngestionRunId: "run_1",
      }),
    ).toBe(
      "https://langfuse.example.test/project/proj_1/sessions/repository-ingestion%3Arun_1",
    )
  })
})

describe("hyperdxSearchUrl", () => {
  it("filters spans by environment and attributes in the run window", () => {
    const url = new URL(
      hyperdxSearchUrl({
        baseUrl: "https://hyperdx.example.test/",
        environment: "ingestion-validator",
        attributes: {
          "request.id": "val_1",
          "ctxpipe.repository.id": "repo_o'1",
        },
        from: "2026-10-03T10:00:00.000Z",
        to: "2026-10-03T11:00:00.000Z",
      }),
    )
    expect(url.origin + url.pathname).toBe(
      "https://hyperdx.example.test/search",
    )
    expect(url.searchParams.get("where")).toBe(
      "ResourceAttributes['deployment.environment'] = 'ingestion-validator' AND SpanAttributes['request.id'] = 'val_1' AND SpanAttributes['ctxpipe.repository.id'] = 'repo_o''1'",
    )
    expect(url.searchParams.get("whereLanguage")).toBe("sql")
    expect(url.searchParams.get("from")).toBe(
      String(Date.parse("2026-10-03T10:00:00.000Z")),
    )
  })
})
