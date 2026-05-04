import { z } from "zod"

/**
 * For optional nullable string fields in `connections` JSON: trim; empty after trim
 * becomes `null` so we do not store whitespace-only values as truthy.
 */
function trimNullableConnectionString(v: unknown): unknown {
  if (v == null) return v
  if (typeof v !== "string") return v
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Typed slice of `connections.config` for `type === "github"`. */
export const githubConnectionConfigSchema = z.object({
  installationId: z.number().int(),
  ingestAllRepositories: z.boolean(),
  includeFutureRepos: z.boolean(),
  /** GitHub org or user URL handle from `installation.account` (REST `login` / `slug`). */
  accountSlug: z.string().min(1).optional(),
})

export type GithubConnectionConfig = z.infer<
  typeof githubConnectionConfigSchema
>

/** Typed slice of `connections.config` for `type === "forge"`. */
const provisionStatusSchema = z.enum(["idle", "running", "succeeded", "failed"])

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
    /** e.g. my-site.atlassian.net (no https) for Forge `install` / CLI. */
    confluenceSiteHost: z.string().nullable().optional(),
    /** Atlassian Marketplace / hosted link to install the Forge app for this connection (non-secret). */
    confluenceForgeInstallUrl: z.string().url().nullable().optional(),
    /** Scoped Atlassian / Forge API token (operator) — same sensitivity as other secrets. */
    forgeScopedApiToken: z.string().nullable().optional(),
    /** Atlassian account email matching `forgeScopedApiToken` (Forge CLI FORGE_EMAIL). */
    forgeOperatorEmail: z.string().nullable().optional(),
    provisionStatus: provisionStatusSchema.optional(),
    provisionErrorCode: z.string().nullable().optional(),
    provisionStderr: z.string().nullable().optional(),
    provisionWorkflowRunId: z.string().nullable().optional(),
    lastProvisionAt: z.string().nullable().optional(),
    /** Atlassian 3LO OAuth app (per Forge connection) — `clientId` is non-secret; `clientSecret` is sensitive. */
    atlassianOAuthClientId: z.preprocess(
      trimNullableConnectionString,
      z.string().nullable().optional(),
    ),
    atlassianOAuthClientSecret: z.preprocess(
      trimNullableConnectionString,
      z.string().nullable().optional(),
    ),
  })
  .transform((c) => ({
    ...c,
    status: c.status ?? "pending",
    provisionStatus: c.provisionStatus ?? "idle",
  }))

export type ForgeConnectionConfig = z.infer<typeof forgeConnectionConfigSchema>

/** Typed slice of `connections.config` for `type === "notion"`. */
export const notionConnectionConfigSchema = z
  .object({
    accessToken: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    botId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    workspaceName: z.string().min(1).optional(),
    workspaceIcon: z.string().url().nullable().optional(),
    ownerUserId: z.string().min(1).optional(),
    status: z.string().optional(),
    lastEventPayload: z.unknown().nullish(),
  })
  .transform((c) => ({
    ...c,
    status: c.status ?? "installed",
  }))

export type NotionConnectionConfig = z.infer<
  typeof notionConnectionConfigSchema
>

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

export function parseNotionConnectionConfig(
  config: Record<string, unknown>,
): NotionConnectionConfig {
  return notionConnectionConfigSchema.parse(config)
}

/** Safe parse of `connections.config` for `type === "forge"`. Use when JSON may be partial or legacy. */
export function tryParseForgeConnectionConfig(
  config: unknown,
): ForgeConnectionConfig | null {
  const r = forgeConnectionConfigSchema.safeParse(config)
  return r.success ? r.data : null
}

/** Persisted JSON for `connections.config` when `type === "github"` — validates on write. */
export function serialiseGithubConnectionConfigForDb(
  input: z.input<typeof githubConnectionConfigSchema>,
): Record<string, unknown> {
  return githubConnectionConfigSchema.parse(input) as unknown as Record<
    string,
    unknown
  >
}

/** Persisted JSON for `connections.config` when `type === "forge"` — validates on write. */
export function serialiseForgeConnectionConfigForDb(
  input: z.input<typeof forgeConnectionConfigSchema>,
): Record<string, unknown> {
  return forgeConnectionConfigSchema.parse(input) as unknown as Record<
    string,
    unknown
  >
}

/** Persisted JSON for `connections.config` when `type === "notion"` — validates on write. */
export function serialiseNotionConnectionConfigForDb(
  input: z.input<typeof notionConnectionConfigSchema>,
): Record<string, unknown> {
  return notionConnectionConfigSchema.parse(input) as unknown as Record<
    string,
    unknown
  >
}
