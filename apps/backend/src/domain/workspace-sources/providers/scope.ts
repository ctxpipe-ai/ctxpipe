import { z } from "zod"

/**
 * The scope part of one `.ctxpipe/sources.yaml` entry for one provider.
 * The scope is the entry without `id`, `provider`, and `connection`.
 *
 * This module imports only `zod`, so the UI can import it too.
 */
export type SourceScopeDefinition<
  S extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** The `connections.type` that a source of this provider must use. */
  connectionType:
    | "github"
    | "forge"
    | "slack"
    | "linear"
    | "notion"
    | "pagerduty"
    | "plain"
  /** The label for one provider, for example "Confluence". */
  label: string
  schema: z.ZodType<S>
  /** A short summary for settings and "Used in", for example "3 spaces". */
  summarize(scope: S): string
}

/**
 * A placeholder scope until the provider agent defines its shape (phase 2).
 * It accepts any object and keeps every key.
 */
export function placeholderScope(
  connectionType: SourceScopeDefinition["connectionType"],
  label: string,
): SourceScopeDefinition {
  return {
    connectionType,
    label,
    schema: z.looseObject({}),
    summarize: () => label,
  }
}
