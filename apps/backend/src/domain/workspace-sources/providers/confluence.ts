import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/** A Confluence space key. It is one path segment under `confluence/`. */
export const confluenceSpaceKeySchema = z
  .string()
  .regex(/^~?[A-Za-z0-9_-]{1,255}$/, "Use a Confluence space key")

export const confluencePageIdSchema = z
  .string()
  .regex(/^[0-9]{1,32}$/, "Use a Confluence page id")

export const confluenceSourceScopeSchema = z
  .object({
    spaces: z
      .array(
        z
          .object({
            key: confluenceSpaceKeySchema,
            /** `all`, or only these pages (and the path to them). */
            pages: z.union([
              z.literal("all"),
              z
                .array(confluencePageIdSchema)
                .min(1)
                .max(1000, "Select at most 1000 pages in one space"),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(50, "Select at most 50 Confluence spaces for one source")
      .refine(
        (spaces) =>
          new Set(spaces.map((space) => space.key)).size === spaces.length,
        "List each space one time",
      ),
  })
  .strict()

export type ConfluenceSourceScope = z.infer<typeof confluenceSourceScopeSchema>

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** The Confluence source scope: spaces, each with all pages or a page list. */
export const confluenceSourceScope: SourceScopeDefinition<ConfluenceSourceScope> =
  {
    connectionType: "forge",
    label: "Confluence",
    schema: confluenceSourceScopeSchema,
    summarize: (scope) => {
      const pages = scope.spaces.reduce(
        (total, space) =>
          space.pages === "all" ? total : total + space.pages.length,
        0,
      )
      const spaces = plural(scope.spaces.length, "Confluence space")
      return pages ? `${spaces} · ${plural(pages, "selected page")}` : spaces
    },
  }
