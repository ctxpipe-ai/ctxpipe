import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  /** Same resolution as backend `signUpstreamJwt` (issuer fallback chain). */
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_BASE_URL: z.string().url().optional(),
  AUTH_TOKEN_AUDIENCE_CODESEARCH: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
