import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../test/msw.js"
import {
  hyperdxSearchUrl,
  langfuseSessionUrl,
  openRouterBaseUrl,
  readLangfuseProjectId,
  readOpenRouterKeyUsage,
  readRepositoryLlmUsage,
} from "./ingestionValidatorTelemetry.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const langfuse = {
  baseUrl: "https://langfuse.example.test",
  authString: Buffer.from("pk-lf:sk-lf").toString("base64"),
}

describe("OpenRouter key usage", () => {
  it("sends chat calls' base only to OpenRouter", () => {
    expect(openRouterBaseUrl({})).toBe("https://openrouter.ai/api/v1")
    expect(
      openRouterBaseUrl({
        MODEL_PROVIDER_URL: "https://openrouter.ai/api/v1/",
      }),
    ).toBe("https://openrouter.ai/api/v1")
    expect(
      openRouterBaseUrl({ MODEL_PROVIDER_URL: "https://llm.internal/v1" }),
    ).toBeNull()
    expect(openRouterBaseUrl({ MODEL_PROVIDER: "bedrock" })).toBeNull()
  })

  it("reads usage and the credit limit of the key", async () => {
    let auth: string | null = null
    server.use(
      http.get("https://openrouter.ai/api/v1/key", ({ request }) => {
        auth = request.headers.get("authorization")
        return HttpResponse.json({
          data: {
            label: "validator",
            usage: 4.25,
            limit: 30,
            limit_remaining: 25.75,
          },
        })
      }),
    )
    await expect(
      readOpenRouterKeyUsage({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
      }),
    ).resolves.toEqual({ usage: 4.25, limit: 30, limitRemaining: 25.75 })
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
  it("sums generations per extraction stage for one repository", async () => {
    const queries: Array<{
      filters: Array<Record<string, string>>
      fromTimestamp: string
    }> = []
    let auth: string | null = null
    server.use(
      http.get(
        "https://langfuse.example.test/api/public/metrics",
        ({ request }) => {
          auth = request.headers.get("authorization")
          const query = JSON.parse(
            new URL(request.url).searchParams.get("query") ?? "{}",
          )
          queries.push(query)
          const stage = query.filters.find(
            (filter: Record<string, string>) =>
              filter.key === "workflowStepName",
          )
          return HttpResponse.json({
            data: [
              stage
                ? {
                    count_count: 2,
                    sum_inputTokens: 100,
                    sum_outputTokens: 20,
                    sum_totalTokens: 120,
                    sum_totalCost: 0.00002,
                  }
                : {
                    count_count: "7",
                    sum_inputTokens: "350",
                    sum_outputTokens: "70",
                    sum_totalTokens: "420",
                    sum_totalCost: "0.00007",
                  },
            ],
          })
        },
      ),
    )
    const usage = await readRepositoryLlmUsage(langfuse, {
      repositoryId: "repo_1",
      from: "2026-10-03T10:00:00.000Z",
      to: "2026-10-03T11:00:00.000Z",
    })
    expect(auth).toBe(`Basic ${langfuse.authString}`)
    expect(Object.keys(usage.stages)).toEqual([
      "identify-roots",
      "extract-kind",
      "identify",
    ])
    expect(usage.stages["extract-kind"]).toEqual({
      calls: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.00002,
    })
    expect(usage.total).toEqual({
      calls: 7,
      inputTokens: 350,
      outputTokens: 70,
      totalTokens: 420,
      costUsd: 0.00007,
    })
    expect(queries).toHaveLength(4)
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
    expect(queries[3]?.fromTimestamp).toBe("2026-10-03T10:00:00.000Z")
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
          "ctxpipe.validator.run_id": "val_1",
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
      "ResourceAttributes['deployment.environment'] = 'ingestion-validator' AND SpanAttributes['ctxpipe.validator.run_id'] = 'val_1' AND SpanAttributes['ctxpipe.repository.id'] = 'repo_o''1'",
    )
    expect(url.searchParams.get("whereLanguage")).toBe("sql")
    expect(url.searchParams.get("from")).toBe(
      String(Date.parse("2026-10-03T10:00:00.000Z")),
    )
  })
})
