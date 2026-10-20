import { IconBrandNotion } from "@tabler/icons-react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  canonicalNotionId,
  type NotionSourceScope,
  notionSourceScopeSchema,
} from "backend/domain/workspace-sources/providers/notion"
import { useEffect, useState } from "react"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import {
  notionConnectorKeys,
  searchNotionResources,
} from "@/features/connectors/queries/notion-connector"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

/** One selected root, as the picker holds it. */
type NotionRootItem = {
  id: string
  type: "page" | "database"
  title: string
}

/** The picker selection of a source scope. A bad scope starts empty. */
function notionScopeToItems(
  scope: Record<string, unknown>,
): NotionRootItem[] {
  const parsed = notionSourceScopeSchema.safeParse(scope)
  if (!parsed.success) return []
  return [
    ...(parsed.data.pages ?? []).map((page) => ({
      ...page,
      type: "page" as const,
    })),
    ...(parsed.data.databases ?? []).map((database) => ({
      ...database,
      type: "database" as const,
    })),
  ]
}

/** The source scope of a picker selection, or null when it is not complete. */
function notionItemsToScope(
  items: readonly NotionRootItem[],
): NotionSourceScope | null {
  const parsed = notionSourceScopeSchema.safeParse(notionItemsScope(items))
  return parsed.success ? parsed.data : null
}

/** The scope of a picker selection, before the schema checks it. */
function notionItemsScope(items: readonly NotionRootItem[]) {
  const roots = (type: NotionRootItem["type"]) =>
    items
      .filter((item) => item.type === type)
      .map((item) => ({
        id: canonicalNotionId(item.id) ?? item.id,
        title: item.title.trim() || "Untitled",
      }))
  const pages = roots("page")
  const databases = roots("database")
  return {
    ...(pages.length ? { pages } : {}),
    ...(databases.length ? { databases } : {}),
  }
}

const itemKey = (item: { type: string; id: string }) =>
  `${item.type}:${item.id}`

/**
 * Select the Notion pages and databases of a source. A page syncs with all
 * its child pages; a database syncs with all its rows.
 */
export function NotionScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [items, setItems] = useState(() => notionScopeToItems(initialScope))
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300)
    return () => clearTimeout(timer)
  }, [search])
  const resultsQuery = useQuery({
    queryKey: notionConnectorKeys.resources(orgSlug, connectionId, query),
    queryFn: () => searchNotionResources(orgSlug, query, connectionId),
    placeholderData: keepPreviousData,
  })
  const loading = useSkeletonHold(resultsQuery.isPending)
  const results: NotionRootItem[] = (resultsQuery.data ?? []).map(
    (resource) => ({
      id: resource.externalId,
      type: resource.type,
      title: resource.title,
    }),
  )
  // As in the Linear picker, a selected item stays in the list when the
  // search does not find it, so the user can always see and clear it.
  const listed = [
    ...items.filter(
      (item) => !results.some((result) => itemKey(result) === itemKey(item)),
    ),
    ...results,
  ]
  const update = (next: NotionRootItem[]) => {
    setItems(next)
    onChange(notionItemsToScope(next))
  }
  const heading = label
    ? `Notion pages and databases for ${label}`
    : "Notion pages and databases"

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        A page syncs with all its child pages. A database syncs with all its
        rows.
      </p>
      <SearchField
        aria-label={`Search Notion for ${label ?? "this source"}`}
        placeholder="Search Notion pages and databases"
        value={search}
        onChange={setSearch}
      />
      <div className="max-h-[min(280px,calc(var(--visual-viewport-height)*0.4))] min-h-0 overflow-auto border border-border p-3">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy>
            <span className="sr-only">Searching Notion</span>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-5 items-center gap-2">
                <Skeleton className="size-4.5 shrink-0" />
                <SkeletonText
                  className="min-w-0 flex-1 text-sm"
                  boneClassName="h-3.5 w-48"
                />
              </div>
            ))}
          </div>
        ) : resultsQuery.isError ? (
          <InlineAlert variant="error">
            Could not search Notion. Try again.
          </InlineAlert>
        ) : listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pages or databases found. Share them with the ctx| integration in
            Notion, then search again.
          </p>
        ) : (
          <CheckboxGroup
            aria-label="Search results"
            value={items.map(itemKey)}
            onChange={(keys) =>
              update(listed.filter((item) => keys.includes(itemKey(item))))
            }
          >
            {listed.map((result) => (
              <Checkbox key={itemKey(result)} value={itemKey(result)}>
                <span className="min-w-0 truncate">{result.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {result.type === "page" ? "Page" : "Database"}
                </span>
              </Checkbox>
            ))}
          </CheckboxGroup>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Select at least one page or database.
        </p>
      ) : null}
      <ScopeLimitAlert
        schema={notionSourceScopeSchema}
        scope={notionItemsScope(items)}
      />
    </section>
  )
}

/** Notion source UI: a search picker of the connection's pages and databases. */
export const notionSourceUi: SourceProviderUi = {
  Icon: IconBrandNotion,
  ScopeEditor: NotionScopeEditor,
}
