import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url().optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(env: Record<string, string | undefined>): Env {
  return envSchema.parse(env)
}
