/**
 * Spend and trace lookups for the ingestion validator: OpenRouter key usage
 * (the dedicated key's credit is the run's hard cap), Langfuse token and cost
 * totals per ingestion stage, and HyperDX / Langfuse links for the report.
 */

export type LlmUsage = {
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number
}

export type OpenRouterKeyUsage = {
  /** Credits used by this key so far, USD. */
  usage: number
  limit: number | null
  limitRemaining: number | null
}

/** The provider base the backend sends chat calls to (see `modelProvider.ts`). */
export function openRouterBaseUrl(
  env: Record<string, string | undefined>,
): string | null {
  if (env.MODEL_PROVIDER === "azure" || env.MODEL_PROVIDER === "bedrock")
    return null
  const base = env.MODEL_PROVIDER_URL?.trim() || "https://openrouter.ai/api/v1"
  return new URL(base).hostname.endsWith("openrouter.ai")
    ? base.replace(/\/$/, "")
    : null
}

/** `GET /key`: usage and credit limit of the key the backend runs with. */
export async function readOpenRouterKeyUsage(input: {
  baseUrl: string
  apiKey: string
}): Promise<OpenRouterKeyUsage> {
  const res = await fetch(`${input.baseUrl}/key`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`OpenRouter key lookup failed: ${res.status}`)
  const body = (await res.json()) as {
    data?: {
      usage?: unknown
      limit?: unknown
      limit_remaining?: unknown
    }
  }
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null
  const usage = number(body.data?.usage)
  if (usage === null) throw new Error("OpenRouter key lookup had no usage")
  return {
    usage,
    limit: number(body.data?.limit),
    limitRemaining: number(body.data?.limit_remaining),
  }
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

/**
 * Ingestion stages as the extraction steps name them. Every LangChain
 * generation inherits `repositoryId` and `workflowStepName` metadata from
 * `withIngestAgentContext`.
 */
export const LLM_STAGES = [
  { stage: "identify-roots", operator: "=", value: "identify-roots" },
  { stage: "extract-kind", operator: "starts with", value: "extract-kind:" },
  { stage: "identify", operator: "starts with", value: "identify:" },
] as const

function measure(row: Record<string, unknown>, name: string): number {
  const key = Object.keys(row).find((candidate) =>
    candidate.toLowerCase().endsWith(name.toLowerCase()),
  )
  const value = key === undefined ? undefined : Number(row[key])
  return value !== undefined && Number.isFinite(value) ? value : 0
}

async function langfuseUsage(
  config: LangfuseConfig,
  input: {
    from: string
    to: string
    filters: Array<Record<string, string>>
  },
): Promise<LlmUsage> {
  const query = {
    view: "observations",
    dimensions: [],
    metrics: [
      { measure: "count", aggregation: "count" },
      { measure: "inputTokens", aggregation: "sum" },
      { measure: "outputTokens", aggregation: "sum" },
      { measure: "totalTokens", aggregation: "sum" },
      { measure: "totalCost", aggregation: "sum" },
    ],
    filters: [
      { column: "type", operator: "=", value: "GENERATION", type: "string" },
      ...input.filters,
    ],
    fromTimestamp: input.from,
    toTimestamp: input.to,
  }
  const body = (await langfuseGet(
    config,
    `/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
  )) as { data?: Array<Record<string, unknown>> }
  const row = body.data?.[0] ?? {}
  return {
    calls: measure(row, "count"),
    inputTokens: measure(row, "inputTokens"),
    outputTokens: measure(row, "outputTokens"),
    totalTokens: measure(row, "totalTokens"),
    costUsd: measure(row, "totalCost"),
  }
}

/** Langfuse generations of one repository's ingestion, per extraction stage and in total. */
export async function readRepositoryLlmUsage(
  config: LangfuseConfig,
  input: { repositoryId: string; from: string; to: string },
): Promise<{ stages: Record<string, LlmUsage>; total: LlmUsage }> {
  const repository = {
    column: "metadata",
    operator: "=",
    key: "repositoryId",
    value: input.repositoryId,
    type: "stringObject",
  }
  const stages: Record<string, LlmUsage> = {}
  for (const stage of LLM_STAGES) {
    stages[stage.stage] = await langfuseUsage(config, {
      from: input.from,
      to: input.to,
      filters: [
        repository,
        {
          column: "metadata",
          operator: stage.operator,
          key: "workflowStepName",
          value: stage.value,
          type: "stringObject",
        },
      ],
    })
  }
  const total = await langfuseUsage(config, {
    from: input.from,
    to: input.to,
    filters: [repository],
  })
  return { stages, total }
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
