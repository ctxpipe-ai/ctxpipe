import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1).default("ctxpipe-dev-auth-secret"),
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_TOKEN_AUDIENCE_CODESEARCH: z.string().min(1).optional(),
  GITHUB_TOKEN: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z.string().min(1).optional(),
  ),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
