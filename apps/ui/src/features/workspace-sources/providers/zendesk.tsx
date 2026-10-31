import { useQuery } from "@tanstack/react-query"
import { zendeskSourceScopeSchema } from "backend/domain/workspace-sources/providers/zendesk"
import { useState } from "react"

import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import {
  Skeleton,
  SkeletonLine,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { ZendeskMark } from "@/features/connectors/components/ZendeskMark"
import {
  fetchZendeskCatalog,
  zendeskConnectorKeys,
} from "@/features/connectors/queries/zendesk-connector"
import { retryQuery } from "@/lib/api-result"

import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

type Option = { id: string; name: string }

/**
 * The listed options: each selected id (named from the catalog, or by its
 * id when Zendesk no longer lists it), then the catalog items that match
 * the filter. A selected item stays in the list, so the user can clear it.
 */
function listed(
  catalog: Option[],
  selected: string[],
  needle: string,
  fallback: (id: string) => string,
): Option[] {
  return [
    ...selected
      .filter((id) => !catalog.some((option) => option.id === id))
      .map((id) => ({ id, name: fallback(id) })),
    ...catalog.filter(
      (option) =>
        selected.includes(option.id) ||
        option.name.toLowerCase().includes(needle),
    ),
  ]
}

/**
 * Select the Help Center categories and ticket views of a source. A
 * category syncs all its published articles; a view syncs its latest
 * tickets with their comments.
 */
export function ZendeskScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const initial = zendeskSourceScopeSchema.safeParse(initialScope)
  const [categories, setCategories] = useState<string[]>(
    initial.success ? (initial.data.categories ?? []) : [],
  )
  const [views, setViews] = useState<string[]>(
    initial.success ? (initial.data.views ?? []) : [],
  )
  const [filter, setFilter] = useState("")
  const catalogQuery = useQuery({
    queryKey: zendeskConnectorKeys.catalog(orgSlug, connectionId),
    queryFn: () => fetchZendeskCatalog(orgSlug, connectionId),
    retry: retryQuery,
  })
  const loading = useSkeletonHold(catalogQuery.isPending)
  const needle = filter.trim().toLowerCase()
  // The scope leaves out an empty list.
  const scopeOf = (next: { categories: string[]; views: string[] }) => ({
    ...(next.categories.length ? { categories: next.categories } : {}),
    ...(next.views.length ? { views: next.views } : {}),
  })
  const update = (next: { categories: string[]; views: string[] }) => {
    setCategories(next.categories)
    setViews(next.views)
    const parsed = zendeskSourceScopeSchema.safeParse(scopeOf(next))
    onChange(parsed.success ? parsed.data : null)
  }
  // Keep the order of the selection, then add new picks at the end.
  const merge = (current: string[], picked: string[]) => [
    ...current.filter((id) => picked.includes(id)),
    ...picked.filter((id) => !current.includes(id)),
  ]
  const heading = label
    ? `Zendesk categories and views for ${label}`
    : "Zendesk categories and views"
  const data = catalogQuery.data
  const groups = data
    ? [
        {
          name: "Help Center categories",
          options: listed(
            data.categories,
            categories,
            needle,
            (id) => `Category ${id}`,
          ),
          value: categories,
          onChange: (picked: string[]) =>
            update({ categories: merge(categories, picked), views }),
        },
        {
          name: "Ticket views",
          options: listed(
            data.views.map((view) => ({ id: view.id, name: view.title })),
            views,
            needle,
            (id) => `View ${id}`,
          ),
          value: views,
          onChange: (picked: string[]) =>
            update({ categories, views: merge(views, picked) }),
        },
      ]
    : []

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        A category syncs all its published articles. A view syncs once a day,
        with its 100 most recently updated tickets and their comments. Ticket
        comments can hold personal data, and git keeps every version.
      </p>
      <SearchField
        aria-label={`Filter Zendesk categories and views for ${label ?? "this source"}`}
        placeholder="Filter categories and views"
        value={filter}
        onChange={setFilter}
      />
      <div className="max-h-[min(320px,calc(var(--visual-viewport-height)*0.45))] min-h-0 overflow-auto rounded-md border border-border p-3">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy>
            <span className="sr-only">
              Loading Zendesk categories and views
            </span>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-5 items-center gap-2">
                <Skeleton className="size-4 shrink-0" />
                <SkeletonLine className="h-3.5 w-48" />
              </div>
            ))}
          </div>
        ) : catalogQuery.isError ? (
          <InlineAlert variant="error">
            {catalogQuery.error instanceof Error
              ? catalogQuery.error.message
              : "Could not load Zendesk categories and views. Try again."}
          </InlineAlert>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <CheckboxGroup
                key={group.name}
                label={group.name}
                value={group.value}
                onChange={group.onChange}
              >
                {group.options.length ? (
                  group.options.map((option) => (
                    <Checkbox key={option.id} value={option.id}>
                      <span className="min-w-0 truncate">{option.name}</span>
                    </Checkbox>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">None found.</p>
                )}
              </CheckboxGroup>
            ))}
          </div>
        )}
      </div>
      {categories.length + views.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Select at least one category or view.
        </p>
      ) : null}
      <ScopeLimitAlert
        schema={zendeskSourceScopeSchema}
        scope={scopeOf({ categories, views })}
      />
    </section>
  )
}

/** Zendesk source UI: Help Center categories and ticket views. */
export const zendeskSourceUi: SourceProviderUi = {
  Icon: ZendeskMark,
  ScopeEditor: ZendeskScopeEditor,
}
