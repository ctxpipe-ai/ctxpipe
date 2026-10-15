import { z } from "zod"
import { buildkiteSourceScope } from "./providers/buildkite.js"
import { confluenceSourceScope } from "./providers/confluence.js"
import { githubSourceScope } from "./providers/github.js"
import { linearSourceScope } from "./providers/linear.js"
import { notionSourceScope } from "./providers/notion.js"
import { pagerdutySourceScope } from "./providers/pagerduty.js"
import type { SourceScopeDefinition } from "./providers/scope.js"
import { slackSourceScope } from "./providers/slack.js"

/**
 * The shared schema of `.ctxpipe/sources.yaml`, the source of truth for the
 * sources of one Workspace. The backend and the UI import this module, so it
 * imports only `zod` and the provider scope modules.
 */

export const SOURCES_FILE_PATH = ".ctxpipe/sources.yaml"

export const SOURCE_PROVIDERS = [
  "github",
  "confluence",
  "linear",
  "notion",
  "slack",
  "pagerduty",
  "buildkite",
] as const

export const sourceProviderSchema = z.enum(SOURCE_PROVIDERS)
export type SourceProvider = z.infer<typeof sourceProviderSchema>

/** Each provider adds its scope shape here (one module for each provider). */
export const SOURCE_SCOPES: Record<SourceProvider, SourceScopeDefinition> = {
  github: githubSourceScope,
  confluence: confluenceSourceScope,
  linear: linearSourceScope,
  notion: notionSourceScope,
  slack: slackSourceScope,
  pagerduty: pagerdutySourceScope,
  buildkite: buildkiteSourceScope,
}

export const SOURCE_STATUSES = [
  "ok",
  "invalid",
  "connection_missing",
  "out_of_access",
] as const
export const sourceStatusSchema = z.enum(SOURCE_STATUSES)
export type SourceStatus = z.infer<typeof sourceStatusSchema>

/** The stable key of a source, unique in the file. */
export const sourceKeySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "Use lowercase letters, digits, and hyphens (at most 63 characters)",
  )

export const sourceConnectionIdSchema = z
  .string()
  .regex(/^con_[A-Za-z0-9_-]+$/, "Use a connection id (con_…)")

/** The generic entry keys; a provider scope must not use them. */
export const RESERVED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "provider",
  "connection",
])

/** The generic fields of one entry. The other keys are the provider scope. */
export const sourceEntryBaseSchema = z.object({
  id: sourceKeySchema,
  provider: sourceProviderSchema,
  connection: sourceConnectionIdSchema,
})

/**
 * The file shape. Entries stay `unknown` here, so that one bad entry does
 * not make the full file invalid. Use {@link parseSourceEntry} on each entry.
 */
export const sourcesFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.unknown()).default([]),
})

export type SourceEntry = {
  key: string
  provider: SourceProvider
  connectionId: string
  scope: Record<string, unknown>
}

export type ParsedSourceEntry =
  | { ok: true; entry: SourceEntry }
  | {
      ok: false
      /** Present when the entry has a usable `id`. */
      key: string | null
      provider: SourceProvider | null
      connectionId: string | null
      detail: string
    }

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ")
}

/** Split one entry into generic fields and provider scope, and validate both. */
export function parseSourceEntry(raw: unknown): ParsedSourceEntry {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null
  const key = sourceKeySchema.safeParse(record?.id)
  const provider = sourceProviderSchema.safeParse(record?.provider)
  const connection = sourceConnectionIdSchema.safeParse(record?.connection)
  const partial = {
    key: key.success ? key.data : null,
    provider: provider.success ? provider.data : null,
    connectionId: connection.success ? connection.data : null,
  }
  if (!record)
    return { ok: false, ...partial, detail: "An entry must be a map" }
  const base = sourceEntryBaseSchema.safeParse(record)
  if (!base.success)
    return { ok: false, ...partial, detail: issuesText(base.error) }
  const rawScope = Object.fromEntries(
    Object.entries(record).filter(([name]) => !RESERVED_ENTRY_KEYS.has(name)),
  )
  const scope = SOURCE_SCOPES[base.data.provider].schema.safeParse(rawScope)
  if (!scope.success)
    return { ok: false, ...partial, detail: issuesText(scope.error) }
  return {
    ok: true,
    entry: {
      key: base.data.id,
      provider: base.data.provider,
      connectionId: base.data.connection,
      scope: scope.data,
    },
  }
}

/** The YAML object of one entry, with the generic fields first. */
export function sourceEntryToObject(
  entry: SourceEntry,
): Record<string, unknown> {
  const scope = Object.fromEntries(
    Object.entries(entry.scope).filter(
      ([name]) => !RESERVED_ENTRY_KEYS.has(name),
    ),
  )
  return {
    id: entry.key,
    provider: entry.provider,
    connection: entry.connectionId,
    ...scope,
  }
}

export function summarizeSourceScope(
  provider: SourceProvider,
  scope: Record<string, unknown>,
): string {
  return SOURCE_SCOPES[provider].summarize(scope)
}
