import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/** A Notion page or data source id, in the dashed lowercase form of the API. */
export const notionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "Use a Notion id with dashes, for example 1a2b3c4d-0000-4000-8000-000000000001",
  )

/** Put a Notion id from a URL or from the API into the scope form. */
export function canonicalNotionId(id: string): string | null {
  const hex = id.replaceAll("-", "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * One selected root. The title names the root folder in the Workspace
 * repository, so the folder stays when the page is renamed in Notion.
 */
const notionRootSchema = z
  .object({
    id: notionIdSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict()

const rootList = (label: string) =>
  z
    .array(notionRootSchema)
    .min(1)
    .max(100, `Select at most 100 ${label}s for one source`)
    .refine(
      (roots) => new Set(roots.map((root) => root.id)).size === roots.length,
      `List each ${label} one time`,
    )

export const notionSourceScopeSchema = z
  .object({
    /** Root pages. Each one syncs with all its child pages. */
    pages: rootList("page").optional(),
    /** Databases (data sources). Each one syncs with all its rows. */
    databases: rootList("database").optional(),
  })
  .strict()
  .refine(
    (scope) => Boolean(scope.pages?.length || scope.databases?.length),
    "Select at least one Notion page or database",
  )

export type NotionSourceScope = z.infer<typeof notionSourceScopeSchema>

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** The Notion source scope: root pages and databases. */
export const notionSourceScope: SourceScopeDefinition<NotionSourceScope> = {
  connectionType: "notion",
  label: "Notion",
  schema: notionSourceScopeSchema,
  summarize: (scope) =>
    [
      scope.pages?.length ? plural(scope.pages.length, "Notion page") : null,
      scope.databases?.length
        ? plural(scope.databases.length, "Notion database")
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
}
