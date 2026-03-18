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
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
  AUTH_TOKEN_AUDIENCE_CODESEARCH: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),

  // Email (SMTP)
  SMTP_CONNECTION_URL: z.string().url().optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // Graph DB (OpenCypher: FalkorDB, Neo4j, Memgraph, Neptune)
  GRAPH_DB_URI: z.string().url().optional(),
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

  // Atlassian OAuth 2.0 (3LO) — Cloud connectors
  // Register at developer.atlassian.com; callback: {PUBLIC_URL}/oauth/atlassian/callback
  ATLASSIAN_CLIENT_ID: z.string().transform((v) => v || undefined).optional(),
  ATLASSIAN_CLIENT_SECRET: z.string().transform((v) => v || undefined).optional(),

  // AES-256-GCM key for encrypting OAuth refresh tokens at rest.
  // Generate with: openssl rand -hex 32
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .transform((v) => v || undefined)
    .refine((v) => !v || v.length === 64, "TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
    .optional(),

  // Public-facing URL of this backend, used to construct OAuth callback URLs.
  // e.g. https://api.ctxpipe.com (no trailing slash)
  PUBLIC_URL: z.string().url().optional(),

  // LLM (OpenRouter)
  MODEL_PROVIDER_API_KEY: z.string().min(1).optional(),
  MODEL_PROVIDER_URL: z.string().url().optional(),
  LANGSMITH_API_KEY: z.string().min(1).optional(),

  // LangSmith Studio (embedded LangGraph API)
  ENABLE_LANGSMITH: z
    .string()
    .optional()
    .transform((v) => v === "true"),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables. Use in the Bun/Node entrypoint.
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
