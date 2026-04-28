import { z } from "zod"

/** Typed slice of `connections.config` for `type === "github"`. */
export const githubConnectionConfigSchema = z.object({
  installationId: z.number().int(),
  ingestAllRepositories: z.boolean(),
  includeFutureRepos: z.boolean(),
  /** GitHub org or user URL handle from `installation.account` (REST `login` / `slug`). */
  accountSlug: z.string().min(1).optional(),
})

export type GithubConnectionConfig = z.infer<typeof githubConnectionConfigSchema>

/** Typed slice of `connections.config` for `type === "forge"`. */
export const forgeConnectionConfigSchema = z
  .object({
    cloudId: z.string().nullable().optional(),
    installationContext: z.string().nullable().optional(),
    installationId: z.string().nullable().optional(),
    appId: z.string().nullable().optional(),
    appSystemToken: z.string().nullable().optional(),
    atlassianApiBaseUrl: z.string().nullable().optional(),
    installedByUserId: z.string().nullable().optional(),
    status: z.string().optional(),
    lastEventPayload: z.unknown().nullish(),
  })
  .transform((c) => ({
    ...c,
    status: c.status ?? "pending",
  }))

export type ForgeConnectionConfig = z.infer<typeof forgeConnectionConfigSchema>

export function parseGithubConnectionConfig(
  config: Record<string, unknown>,
): GithubConnectionConfig {
  return githubConnectionConfigSchema.parse(config)
}

export function parseForgeConnectionConfig(
  config: Record<string, unknown>,
): ForgeConnectionConfig {
  return forgeConnectionConfigSchema.parse(config)
}

/** Persisted JSON for `connections.config` when `type === "github"` — validates on write. */
export function serialiseGithubConnectionConfigForDb(
  input: z.input<typeof githubConnectionConfigSchema>,
): Record<string, unknown> {
  return githubConnectionConfigSchema.parse(
    input,
  ) as unknown as Record<string, unknown>
}

/** Persisted JSON for `connections.config` when `type === "forge"` — validates on write. */
export function serialiseForgeConnectionConfigForDb(
  input: z.input<typeof forgeConnectionConfigSchema>,
): Record<string, unknown> {
  return forgeConnectionConfigSchema.parse(
    input,
  ) as unknown as Record<string, unknown>
}
