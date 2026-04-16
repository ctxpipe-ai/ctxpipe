import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  CODESEARCH_URL: z.string().url().optional(),
  UI_PROXY_URL: z.string().url().default("http://localhost:3002"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_BASE_URL: z.string().url().default("https://localhost:3000"),
  /**
   * Public origin used in generated MCP URLs (e.g. GitHub PR onboarding).
   * Defaults to {@link AUTH_BASE_URL}. Set when auth/API base differs from the URL
   * users and agents should call (same idea as `CTXPIPE_PUBLIC_APP_URL` for the UI build).
   */
  MCP_STREAM_BASE_URL: z.preprocess((v) => {
    if (v === undefined || v === null) return undefined
    const s = String(v).trim()
    return s === "" ? undefined : s
  }, z.string().url().optional()),
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
  AUTH_TOKEN_AUDIENCE_CODESEARCH: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  ATLASSIAN_CLIENT_ID: z.string().min(1).optional(),
  ATLASSIAN_CLIENT_SECRET: z.string().min(1).optional(),

  // Email (SMTP)
  SMTP_CONNECTION_URL: z.string().url().optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // Graph DB (OpenCypher: FalkorDB, Neo4j, Memgraph, Neptune)
  GRAPH_DB_URI: z.string().url().default("redis://falkordb:6379"),
  GRAPH_DB_USER: z.string().min(1).optional(),
  GRAPH_DB_PASSWORD: z.string().optional(),
  GRAPH_DB_PROVIDER: z
    .enum([
      "falkordb",
      "neo4j-enterprise",
      "neo4j-community",
      "memgraph",
      "neptune",
    ])
    .default("falkordb"),

  // LLM and embeddings (OpenRouter, OpenAI, Vertex, Bedrock, Ollama, etc.)
  MODEL_PROVIDER_API_KEY: z.string().min(1).optional(),
  MODEL_PROVIDER_URL: z.string().url().optional(),
  MODEL_FAST_NAME: z.string().optional(),
  MODEL_MEDIUM_NAME: z.string().optional(),
  MODEL_HIGH_NAME: z.string().optional(),
  MODEL_EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  MODEL_EMBEDDING_PROVIDER_API_KEY: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().optional(),

  // LangGraph Studio (embedded LangGraph API for dev)
  ENABLE_LANGSMITH: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // OpenTelemetry (traces, logs, metrics)
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
  // ctxpipe github app
  GITHUB_APP_ID: z.string().min(1).optional(),
  /** Full PEM content (multiline). Prefer over GITHUB_PRIVATE_KEY_PATH for Railway etc. */
  GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

  /** If unset, Amplitude is off: no product analytics events are sent (see `observability/amplitude.ts`). */
  AMPLITUDE_API_KEY: z.string().min(1).optional(),
  AMPLITUDE_REGION: z
    .string()
    .optional()
    .transform((v): "us" | "eu" =>
      v?.trim().toLowerCase() === "eu" ? "eu" : "us",
    ),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables. Use in the Bun/Node entrypoint.
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
