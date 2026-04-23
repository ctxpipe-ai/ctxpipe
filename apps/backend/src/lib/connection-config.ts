import { z } from "zod"

/** Typed slice of `connections.config` for `type === "github"`. */
export const githubConnectionConfigSchema = z.object({
  installationId: z.number().int(),
  ingestAllRepositories: z.boolean(),
  includeFutureRepos: z.boolean(),
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
    lastEventPayload: z.unknown().optional(),
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
