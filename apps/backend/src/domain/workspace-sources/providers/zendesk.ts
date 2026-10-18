import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * The most Help Center categories, and the most ticket views, in one Zendesk
 * source. Each one adds list requests to each sync, and Zendesk limits the
 * API requests of one account in each minute. A team selects far fewer.
 */
export const ZENDESK_SOURCE_MAX_ITEMS = 50

/** A Zendesk id, for example `360001234567`. It is also a path segment. */
const zendeskIdSchema = z
  .string()
  .regex(/^\d{1,20}$/, "Use a Zendesk id, for example 360001234567")

const uniqueIds = (what: string, plural: string) =>
  z
    .array(zendeskIdSchema)
    .max(
      ZENDESK_SOURCE_MAX_ITEMS,
      `Select at most ${ZENDESK_SOURCE_MAX_ITEMS} Zendesk ${plural}`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      `List each ${what} one time`,
    )

export const zendeskSourceScopeSchema = z
  .object({
    /** Help Center categories whose articles sync (ADR-054). */
    categories: uniqueIds("category", "categories").optional(),
    /** Ticket views whose latest tickets sync, with their comments. */
    views: uniqueIds("view", "views").optional(),
  })
  .strict()
  .refine(
    (scope) => (scope.categories?.length ?? 0) + (scope.views?.length ?? 0) > 0,
    "Select at least one Help Center category or ticket view",
  )

export type ZendeskSourceScope = z.infer<typeof zendeskSourceScopeSchema>

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** The Zendesk source scope: Help Center categories and ticket views. */
export const zendeskSourceScope: SourceScopeDefinition<ZendeskSourceScope> = {
  connectionType: "zendesk",
  label: "Zendesk",
  schema: zendeskSourceScopeSchema,
  summarize: ({ categories = [], views = [] }) =>
    [
      categories.length
        ? count(
            categories.length,
            "Help Center category",
            "Help Center categories",
          )
        : null,
      views.length ? count(views.length, "ticket view", "ticket views") : null,
    ]
      .filter(Boolean)
      .join(", "),
}
