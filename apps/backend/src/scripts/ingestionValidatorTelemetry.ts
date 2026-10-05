/**
 * Spend and trace lookups for the ingestion validator: OpenRouter key usage
 * (the dedicated key's credit is the run's hard cap), Langfuse tokens and
 * cost per ingestion stage and the models those generations used, and
 * HyperDX / Langfuse links for the report.
 */
import { setTimeout as sleep } from "node:timers/promises"
import type { Env } from "../config/env.js"
import { resolveChatBaseUrl } from "../retrieval/services/modelProvider.js"

export type LlmUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Langfuse cost; `null` when a generation has tokens and no Langfuse cost. */
  costUsd: number | null
}

export type OpenRouterKeyUsage = {
  /** Credits used by this key so far, USD. */
  usage: number
  limit: number | null
}

/** The key and base the backend sends chat calls to, when that is OpenRouter. */
export function openRouterKey(
  env: Env,
): { baseUrl: string; apiKey: string } | null {
  const provider = env.MODEL_PROVIDER ?? "openai-like"
  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim()
  if (provider === "azure" || provider === "bedrock" || !apiKey) return null
  const baseUrl = resolveChatBaseUrl(provider, env.MODEL_PROVIDER_URL).replace(
    /\/$/,
    "",
  )
  return new URL(baseUrl).hostname.endsWith("openrouter.ai")
    ? { baseUrl, apiKey }
    : null
}

/** `GET /key`: usage and credit limit of the key the backend runs with. */
export async function readOpenRouterKeyUsage(key: {
  baseUrl: string
  apiKey: string
}): Promise<OpenRouterKeyUsage> {
  const res = await fetch(`${key.baseUrl}/key`, {
    headers: { Authorization: `Bearer ${key.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`OpenRouter key lookup failed: ${res.status}`)
  const body = (await res.json()) as {
    data?: { usage?: unknown; limit?: unknown }
  }
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  const usage = number(body.data?.usage)
  if (usage === null) throw new Error("OpenRouter key lookup had no usage")
  return { usage, limit: number(body.data?.limit) }
}

export type LangfuseConfig = {
  baseUrl: string
  /** `LANGFUSE_AUTH_STRING`: base64(`pk:sk`) of the project API key (ops/observability/USING.md). */
  authString: string
}

async function langfuseGet(
  config: LangfuseConfig,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    headers: { Authorization: `Basic ${config.authString}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok)
    throw new Error(`Langfuse ${path.split("?")[0]} failed: ${res.status}`)
  return res.json()
}

/** Project the API keys belong to; links need its id. */
export async function readLangfuseProjectId(
  config: LangfuseConfig,
): Promise<string | null> {
  const body = (await langfuseGet(config, "/api/public/projects")) as {
    data?: Array<{ id?: unknown }>
  }
  const id = body.data?.[0]?.id
  return typeof id === "string" ? id : null
}

function measure(row: Record<string, unknown>, name: string): number {
  const key = Object.keys(row).find((candidate) =>
    candidate.toLowerCase().endsWith(name.toLowerCase()),
  )
  const value = key === undefined ? undefined : Number(row[key])
  return value !== undefined && Number.isFinite(value) ? value : 0
}

type Filter = Record<string, string>

async function langfuseRows(
  config: LangfuseConfig,
  input: {
    environment: string
    from: string
    to: string
    filters: Filter[]
    dimensions?: string[]
  },
): Promise<Array<Record<string, unknown>>> {
  const query = {
    view: "observations",
    dimensions: (input.dimensions ?? []).map((field) => ({ field })),
    metrics: [
      { measure: "count", aggregation: "count" },
      { measure: "inputTokens", aggregation: "sum" },
      { measure: "outputTokens", aggregation: "sum" },
      { measure: "totalTokens", aggregation: "sum" },
      { measure: "totalCost", aggregation: "sum" },
    ],
    filters: [
      { column: "type", operator: "=", value: "GENERATION", type: "string" },
      {
        column: "environment",
        operator: "=",
        value: input.environment,
        type: "string",
      },
      ...input.filters,
    ],
    fromTimestamp: input.from,
    toTimestamp: input.to,
  }
  const body = (await langfuseGet(
    config,
    `/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
  )) as { data?: Array<Record<string, unknown>> }
  return body.data ?? []
}

function usage(row: Record<string, unknown> | undefined): LlmUsage {
  const r = row ?? {}
  const totalTokens = measure(r, "totalTokens")
  const costUsd = measure(r, "totalCost")
  return {
    calls: measure(r, "count"),
    inputTokens: measure(r, "inputTokens"),
    outputTokens: measure(r, "outputTokens"),
    totalTokens,
    costUsd: costUsd === 0 && totalTokens > 0 ? null : costUsd,
  }
}

function metadata(key: string, operator: string, value: string): Filter {
  return { column: "metadata", operator, key, value, type: "stringObject" }
}

export type RepositoryLlm = {
  /** Per stage; `embeddings` is hydrate's `modelProvider.generateEmbeddings`. */
  stages: Record<string, LlmUsage>
  total: LlmUsage
  /** Model name → generations, from the same generations. */
  models: Record<string, number>
}

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd:
      left.costUsd === null || right.costUsd === null
        ? null
        : left.costUsd + right.costUsd,
  }
}

/**
 * Langfuse generations of one repository's ingestion window. Extraction
 * generations inherit `repositoryId` and `workflowStepName` metadata from
 * `withIngestAgentContext`. Hydrate embeddings carry no repository: the
 * run id is only a trace-level attribute, which an observation filter cannot
 * match. They are found by name inside the repository's window, which is
 * this repository's alone only when `exclusiveWindow` (concurrency 1);
 * otherwise they are not read. The commit-subject call is not traced, so it
 * appears only in the OpenRouter delta.
 */
export async function readRepositoryLlmUsage(
  config: LangfuseConfig,
  input: {
    repositoryId: string
    /** `deployment.environment` of the run; Langfuse stores it as the environment. */
    environment: string
    exclusiveWindow: boolean
    from: string
    to: string
  },
): Promise<RepositoryLlm> {
  const window = {
    environment: input.environment,
    from: input.from,
    to: input.to,
  }
  const repository = metadata("repositoryId", "=", input.repositoryId)
  const stageFilters: Record<string, Filter[] | null> = {
    "identify-roots": [
      repository,
      metadata("workflowStepName", "=", "identify-roots"),
    ],
    "extract-kind": [
      repository,
      metadata("workflowStepName", "starts with", "extract-kind:"),
    ],
    identify: [
      repository,
      metadata("workflowStepName", "starts with", "identify:"),
    ],
    embeddings: input.exclusiveWindow
      ? [
          {
            column: "name",
            operator: "=",
            value: "modelProvider.generateEmbeddings",
            type: "string",
          },
        ]
      : null,
  }
  const stages: Record<string, LlmUsage> = {}
  const models: Record<string, number> = {}
  for (const [stage, filters] of Object.entries(stageFilters)) {
    const rows = filters
      ? await langfuseRows(config, {
          ...window,
          filters,
          dimensions: ["providedModelName"],
        })
      : []
    stages[stage] = usage(undefined)
    for (const row of rows) {
      const name = String(row.providedModelName ?? "(unknown)")
      stages[stage] = addUsage(stages[stage], usage(row))
      models[name] = (models[name] ?? 0) + measure(row, "count")
    }
  }
  const total = Object.values(stages).reduce(addUsage)
  return { stages, total, models }
}

/**
 * Generations reach Langfuse through the collector's batch exporter. Wait
 * until the count of all generations in the environment since the run
 * started stops changing between reads (bounded). The count includes the
 * hydrate embeddings, which carry no repository.
 */
export async function waitForLangfuseIngestion(
  config: LangfuseConfig,
  input: {
    environment: string
    from: string
    intervalMs?: number
    maxWaitMs?: number
  },
): Promise<number> {
  const interval = input.intervalMs ?? 15_000
  const deadline = Date.now() + (input.maxWaitMs ?? 300_000)
  let previous = -1
  for (;;) {
    const [row] = await langfuseRows(config, {
      environment: input.environment,
      from: input.from,
      to: new Date().toISOString(),
      filters: [],
    })
    const calls = usage(row).calls
    if (calls === previous || Date.now() >= deadline) return calls
    previous = calls
    await sleep(interval)
  }
}

/** HyperDX search over spans that carry these attributes, in one environment and window. */
export function hyperdxSearchUrl(input: {
  baseUrl: string
  environment: string
  attributes: Record<string, string>
  from: string
  to: string
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const where = [
    `ResourceAttributes['deployment.environment'] = ${quote(input.environment)}`,
    ...Object.entries(input.attributes).map(
      ([key, value]) => `SpanAttributes[${quote(key)}] = ${quote(value)}`,
    ),
  ].join(" AND ")
  const params = new URLSearchParams({
    where,
    whereLanguage: "sql",
    from: String(Date.parse(input.from)),
    to: String(Date.parse(input.to)),
    isLive: "false",
  })
  return `${input.baseUrl.replace(/\/$/, "")}/search?${params}`
}

/** Langfuse session of one repository-ingestion run (`repository-ingestion:<run id>`). */
export function langfuseSessionUrl(input: {
  baseUrl: string
  projectId: string
  repositoryIngestionRunId: string
}): string {
  return `${input.baseUrl.replace(/\/$/, "")}/project/${input.projectId}/sessions/${encodeURIComponent(`repository-ingestion:${input.repositoryIngestionRunId}`)}`
}
