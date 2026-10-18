import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * The permissions of the machine-user API key (ADR-055): read the content,
 * and create and delete the one webhook target of the connection. The
 * backend checks them at connect; the setup lists them.
 */
export const PLAIN_REQUIRED_PERMISSIONS = [
  "helpCenter:read",
  "labelType:read",
  "thread:read",
  "timeline:read",
  "customer:read",
  "user:read",
  "webhookTarget:create",
  "webhookTarget:delete",
]

/**
 * The most Help Centers, and the most thread labels, in one Plain source.
 * Each one adds list requests to each sync, and Plain limits the API
 * requests of one key. A team selects far fewer.
 */
export const PLAIN_SOURCE_MAX_ITEMS = 50

/** A Plain id, for example `lt_01HXYZ`. It is also a path segment. */
export const plainIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,64}$/, "Use a Plain id, for example lt_01HXYZ")

const uniqueIds = (what: string) =>
  z
    .array(plainIdSchema)
    .max(
      PLAIN_SOURCE_MAX_ITEMS,
      `Select at most ${PLAIN_SOURCE_MAX_ITEMS} ${what}s`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      `List each ${what} one time`,
    )

export const plainSourceScopeSchema = z
  .object({
    /** Help Centers whose published articles sync (ADR-055). */
    helpCenters: uniqueIds("Help Center").optional(),
    /** Label types whose newest threads sync, with their messages. */
    labels: uniqueIds("label").optional(),
  })
  .strict()
  .refine(
    (scope) =>
      (scope.helpCenters?.length ?? 0) + (scope.labels?.length ?? 0) > 0,
    "Select at least one Help Center or thread label",
  )

export type PlainSourceScope = z.infer<typeof plainSourceScopeSchema>

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** The Plain source scope: Help Centers and thread labels. */
export const plainSourceScope: SourceScopeDefinition<PlainSourceScope> = {
  connectionType: "plain",
  label: "Plain",
  schema: plainSourceScopeSchema,
  summarize: ({ helpCenters = [], labels = [] }) =>
    [
      helpCenters.length
        ? count(helpCenters.length, "Help Center", "Help Centers")
        : null,
      labels.length
        ? count(labels.length, "thread label", "thread labels")
        : null,
    ]
      .filter(Boolean)
      .join(", "),
}
