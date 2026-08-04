import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_TOKEN_AUDIENCE_CODESEARCH: z.string().min(1).optional(),

  // OpenTelemetry (logs)
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables.
 * Railway variable "clear" sends empty string — treat as unset for optional keys.
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  const cleaned: Record<string, string | undefined> = { ...env }
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === "") delete cleaned[key]
  }
  return envSchema.parse(cleaned)
}
