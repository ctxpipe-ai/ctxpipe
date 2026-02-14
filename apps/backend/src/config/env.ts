import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  NEO4J_URI: z.string().url().optional(),

  // LLM (OpenRouter)
  MODEL_PROVIDER_API_KEY: z.string().min(1).optional(),
  MODEL_PROVIDER_URL: z.string().url().optional(),
  LANGSMITH_API_KEY: z.string().min(1).optional(),

  // LangSmith Studio (Bun only; spawns Agent Server subprocess)
  ENABLE_LANGSMITH: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  LANGSMITH_DEV_PORT: z.coerce.number().default(2024),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables. Use in both Worker and Bun/Node entrypoints.
 * Pass the env object from the runtime (e.g. process.env or Cloudflare env).
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
