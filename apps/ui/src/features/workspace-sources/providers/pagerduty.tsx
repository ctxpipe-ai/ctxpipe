import { useInfiniteQuery } from "@tanstack/react-query"
import {
  type PagerdutySourceScope,
  pagerdutySourceScopeSchema,
} from "backend/domain/workspace-sources/providers/pagerduty"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { Tag, TagGroup } from "@/components/ui/TagGroup"
import { PagerdutyMark } from "@/features/connectors/components/PagerdutyMark"
import {
  pagerdutyConnectorKeys,
  searchPagerdutyServices,
} from "@/features/connectors/queries/pagerduty-connector"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

/** The selected service ids of a source scope. A bad scope starts empty. */
function pagerdutyScopeToServiceIds(
  scope: Record<string, unknown>,
): string[] {
  const parsed = pagerdutySourceScopeSchema.safeParse(scope)
  return parsed.success ? parsed.data.services : []
}

/** The source scope of a selection, or null when it is not complete. */
function pagerdutyServiceIdsToScope(
  ids: readonly string[],
): PagerdutySourceScope | null {
  const parsed = pagerdutySourceScopeSchema.safeParse({ services: [...ids] })
  return parsed.success ? parsed.data : null
}

/**
 * Select the PagerDuty services of a source. ctx| syncs the incidents of
 * each selected service, with their alerts.
 */
export function PagerdutyScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  // The selection keeps the name of each service checked in the picker. An
  // initial id has no name until the results show it.
  const [selected, setSelected] = useState<
    Array<{ id: string; name?: string }>
  >(() => pagerdutyScopeToServiceIds(initialScope).map((id) => ({ id })))
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300)
    return () => clearTimeout(timer)
  }, [search])
  const servicesQuery = useInfiniteQuery({
    queryKey: pagerdutyConnectorKeys.services(orgSlug, connectionId, query),
    queryFn: ({ pageParam }) =>
      searchPagerdutyServices(orgSlug, {
        q: query,
        offset: pageParam,
        connectionId,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.more
        ? pages.reduce((sum, page) => sum + page.items.length, 0)
        : null,
  })
  const loading = useSkeletonHold(servicesQuery.isPending)
  const results = servicesQuery.data?.pages.flatMap((page) => page.items) ?? []
  const inResults = (id: string) => results.some((service) => service.id === id)
  const update = (next: Array<{ id: string; name?: string }>) => {
    setSelected(next)
    onChange(pagerdutyServiceIdsToScope(next.map((service) => service.id)))
  }
  const heading = label
    ? `PagerDuty services for ${label}`
    : "PagerDuty services"

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        ctx| syncs the incidents of each selected service from the last 90 days,
        with their alerts.
      </p>
      <SearchField
        aria-label={`Search PagerDuty services for ${label ?? "this source"}`}
        placeholder="Search PagerDuty services"
        value={search}
        onChange={setSearch}
      />
      <div className="max-h-[min(280px,calc(var(--visual-viewport-height)*0.4))] min-h-0 overflow-auto border border-border p-3">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy>
            <span className="sr-only">Searching PagerDuty</span>
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
        ) : servicesQuery.isError ? (
          <InlineAlert variant="error">
            Could not load PagerDuty services. Try again.
          </InlineAlert>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No services found. Check the search, or the access of the PagerDuty
            connection.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <CheckboxGroup
              aria-label="PagerDuty services"
              value={selected.map((service) => service.id).filter(inResults)}
              onChange={(keys) =>
                update([
                  ...selected.filter((service) => !inResults(service.id)),
                  ...results.filter((service) => keys.includes(service.id)),
                ])
              }
            >
              {results.map((service) => (
                <Checkbox key={service.id} value={service.id}>
                  <span className="min-w-0 truncate">{service.name}</span>
                </Checkbox>
              ))}
            </CheckboxGroup>
            {servicesQuery.hasNextPage ? (
              <Button
                variant="quiet"
                className="self-start"
                isPending={servicesQuery.isFetchingNextPage}
                onPress={() => void servicesQuery.fetchNextPage()}
              >
                Show more services
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {selected.length ? (
        <TagGroup
          label="Selected"
          items={selected.map((service) => ({
            id: service.id,
            name:
              service.name ??
              results.find((result) => result.id === service.id)?.name ??
              service.id,
          }))}
          onRemove={(keys) =>
            update(selected.filter((service) => !keys.has(service.id)))
          }
        >
          {(service) => (
            <Tag id={service.id} textValue={service.name}>
              {service.name}
            </Tag>
          )}
        </TagGroup>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select at least one service.
        </p>
      )}
      <ScopeLimitAlert
        schema={pagerdutySourceScopeSchema}
        scope={{ services: selected.map((service) => service.id) }}
      />
    </section>
  )
}

/** PagerDuty source UI: a search picker of the connection's services. */
export const pagerdutySourceUi: SourceProviderUi = {
  Icon: PagerdutyMark,
  ScopeEditor: PagerdutyScopeEditor,
}
