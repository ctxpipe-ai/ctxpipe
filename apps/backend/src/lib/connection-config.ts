import { z } from "zod"
import type { Env } from "../config/env.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "./connection-secrets.js"

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

/** Stored in `connections.config` for `type === "github"` (includes ciphertext fields). */
export const githubConnectionConfigStoredSchema = z.object({
  /** Set after GitHub redirects back from app installation. */
  installationId: z.number().int().optional(),
  ingestAllRepositories: z.boolean(),
  includeFutureRepos: z.boolean(),
  accountSlug: z.string().min(1).optional(),
  /** GitHub App numeric id as string (from developer settings). */
  githubAppId: z.string().min(1).optional(),
  /** URL slug for `https://github.com/apps/<slug>/installations/new`. */
  appSlug: z.string().min(1).optional(),
  /** AES-GCM ciphertext (see `encryptConnectionSecret`). */
  privateKeyEnc: z.string().min(1).optional(),
  webhookSecretEnc: z.string().min(1).optional(),
})

export type GithubConnectionConfigStored = z.infer<
  typeof githubConnectionConfigStoredSchema
>

/** Plaintext slice after decrypt — never persist or return on list APIs. */
export type GithubAppCredentialsPlaintext = {
  githubAppId: string
  appSlug: string
  privateKey: string
  webhookSecret: string
}

export function parseGithubConnectionStored(
  config: Record<string, unknown>,
): GithubConnectionConfigStored {
  return githubConnectionConfigStoredSchema.parse(config)
}

/** @deprecated Use `parseGithubConnectionStored` */
export function parseGithubConnectionConfig(
  config: Record<string, unknown>,
): GithubConnectionConfigStored {
  return parseGithubConnectionStored(config)
}

/** Persisted JSON for `connections.config` when `type === "github"`. */
export function serialiseGithubConnectionConfigForDb(
  input: z.input<typeof githubConnectionConfigStoredSchema>,
): Record<string, unknown> {
  return githubConnectionConfigStoredSchema.parse(input) as unknown as Record<
    string,
    unknown
  >
}

export function decodeGithubAppCredentials(
  stored: GithubConnectionConfigStored,
  env: Env,
): GithubAppCredentialsPlaintext | undefined {
  if (
    !stored.githubAppId ||
    !stored.appSlug ||
    !stored.privateKeyEnc ||
    !stored.webhookSecretEnc
  ) {
    return undefined
  }
  return {
    githubAppId: stored.githubAppId,
    appSlug: stored.appSlug,
    privateKey: decryptConnectionSecret(stored.privateKeyEnc, env),
    webhookSecret: decryptConnectionSecret(stored.webhookSecretEnc, env),
  }
}

export type GithubConnectionSecretsWrite = {
  githubAppId: string
  appSlug: string
  privateKey: string
  webhookSecret: string
}

export function encodeGithubAppSecretsForDb(
  secrets: GithubConnectionSecretsWrite,
  env: Env,
): Pick<
  GithubConnectionConfigStored,
  "githubAppId" | "appSlug" | "privateKeyEnc" | "webhookSecretEnc"
> {
  return {
    githubAppId: secrets.githubAppId.trim(),
    appSlug: secrets.appSlug.trim(),
    privateKeyEnc: encryptConnectionSecret(secrets.privateKey.trim(), env),
    webhookSecretEnc: encryptConnectionSecret(
      secrets.webhookSecret.trim(),
      env,
    ),
  }
}

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
    webhookVerificationToken: z.string().min(1).optional(),
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
