import { useQuery } from "@tanstack/react-query"
import { plainSourceScopeSchema } from "backend/domain/workspace-sources/providers/plain"
import { useState } from "react"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { PlainMark } from "@/features/connectors/components/PlainMark"
import {
  fetchPlainCatalog,
  plainConnectorKeys,
} from "@/features/connectors/queries/plain-connector"
import { retryQuery } from "@/lib/api-result"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

type Option = { id: string; name: string }

/**
 * The listed options: each selected id (named from the catalog, or by its
 * id when Plain no longer lists it), then the catalog items that match
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
 * Select the Help Centers and thread labels of a source. A Help Center
 * syncs all its published articles; a label syncs its newest threads with
 * their messages and notes.
 */
export function PlainScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const initial = plainSourceScopeSchema.safeParse(initialScope)
  const [helpCenters, setHelpCenters] = useState<string[]>(
    initial.success ? (initial.data.helpCenters ?? []) : [],
  )
  const [labels, setLabels] = useState<string[]>(
    initial.success ? (initial.data.labels ?? []) : [],
  )
  const [filter, setFilter] = useState("")
  const catalogQuery = useQuery({
    queryKey: plainConnectorKeys.catalog(orgSlug, connectionId),
    queryFn: () => fetchPlainCatalog(orgSlug, connectionId),
    retry: retryQuery,
  })
  const loading = useSkeletonHold(catalogQuery.isPending)
  const needle = filter.trim().toLowerCase()
  const update = (next: { helpCenters: string[]; labels: string[] }) => {
    setHelpCenters(next.helpCenters)
    setLabels(next.labels)
    const parsed = plainSourceScopeSchema.safeParse({
      ...(next.helpCenters.length ? { helpCenters: next.helpCenters } : {}),
      ...(next.labels.length ? { labels: next.labels } : {}),
    })
    onChange(parsed.success ? parsed.data : null)
  }
  // Keep the order of the selection, then add new picks at the end.
  const merge = (current: string[], picked: string[]) => [
    ...current.filter((id) => picked.includes(id)),
    ...picked.filter((id) => !current.includes(id)),
  ]
  const heading = label
    ? `Plain Help Centers and labels for ${label}`
    : "Plain Help Centers and labels"
  const data = catalogQuery.data
  const groups = data
    ? [
        {
          name: "Help Centers",
          options: listed(
            data.helpCenters,
            helpCenters,
            needle,
            (id) => `Help Center ${id}`,
          ),
          value: helpCenters,
          onChange: (picked: string[]) =>
            update({ helpCenters: merge(helpCenters, picked), labels }),
        },
        {
          name: "Thread labels",
          options: listed(data.labels, labels, needle, (id) => `Label ${id}`),
          value: labels,
          onChange: (picked: string[]) =>
            update({ helpCenters, labels: merge(labels, picked) }),
        },
      ]
    : []

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        A Help Center syncs all its published articles. A label syncs its 100
        newest threads, with their messages and internal notes. Thread messages
        can hold personal data, and git keeps every version.
      </p>
      <SearchField
        aria-label={`Filter Plain Help Centers and labels for ${label ?? "this source"}`}
        placeholder="Filter Help Centers and labels"
        value={filter}
        onChange={setFilter}
      />
      <div className="max-h-[min(320px,calc(var(--visual-viewport-height)*0.45))] min-h-0 overflow-auto rounded-md border border-border p-3">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy>
            <span className="sr-only">
              Loading Plain Help Centers and labels
            </span>
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
        ) : catalogQuery.isError ? (
          <InlineAlert variant="error">
            {catalogQuery.error instanceof Error
              ? catalogQuery.error.message
              : "Could not load Plain Help Centers and labels. Try again."}
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
      {helpCenters.length + labels.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Select at least one Help Center or label.
        </p>
      ) : null}
      <ScopeLimitAlert
        schema={plainSourceScopeSchema}
        scope={{ helpCenters, labels }}
      />
    </section>
  )
}

/** Plain source UI: Help Centers and thread labels. */
export const plainSourceUi: SourceProviderUi = {
  Icon: PlainMark,
  ScopeEditor: PlainScopeEditor,
}
