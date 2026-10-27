import { useQuery } from "@tanstack/react-query"
import { buildkiteSourceScopeSchema } from "backend/domain/workspace-sources/providers/buildkite"
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
import { BuildkiteMark } from "@/features/connectors/components/BuildkiteMark"
import {
  buildkiteConnectorKeys,
  fetchBuildkitePipelines,
} from "@/features/connectors/queries/buildkite-connector"
import { retryQuery } from "@/lib/api-result"

import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

/**
 * Select the Buildkite pipelines of a source. ctxpipe syncs each pipeline with
 * its latest finished builds.
 */
export function BuildkiteScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [selected, setSelected] = useState<string[]>(() => {
    const parsed = buildkiteSourceScopeSchema.safeParse(initialScope)
    return parsed.success ? parsed.data.pipelines : []
  })
  const [filter, setFilter] = useState("")
  const pipelinesQuery = useQuery({
    queryKey: buildkiteConnectorKeys.pipelines(orgSlug, connectionId),
    queryFn: () => fetchBuildkitePipelines(orgSlug, connectionId),
    retry: retryQuery,
  })
  const loading = useSkeletonHold(pipelinesQuery.isPending)
  const pipelines = pipelinesQuery.data?.items ?? []
  // A selected pipeline stays in the list when the filter hides it, or when
  // Buildkite no longer lists it, so the user can always see and clear it.
  const needle = filter.trim().toLowerCase()
  const listed = [
    ...selected
      .filter((slug) => !pipelines.some((pipeline) => pipeline.slug === slug))
      .map((slug) => ({ slug, name: slug })),
    ...pipelines.filter(
      (pipeline) =>
        selected.includes(pipeline.slug) ||
        pipeline.name.toLowerCase().includes(needle) ||
        pipeline.slug.includes(needle),
    ),
  ]
  const update = (next: string[]) => {
    setSelected(next)
    const parsed = buildkiteSourceScopeSchema.safeParse({ pipelines: next })
    onChange(parsed.success ? parsed.data : null)
  }
  const heading = label
    ? `Buildkite pipelines for ${label}`
    : "Buildkite pipelines"

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <p className="text-sm text-muted-foreground">
        ctxpipe syncs each pipeline with its latest 25 finished builds and the
        jobs that failed.
      </p>
      <SearchField
        aria-label={`Filter Buildkite pipelines for ${label ?? "this source"}`}
        placeholder="Filter pipelines"
        value={filter}
        onChange={setFilter}
      />
      <div className="max-h-[min(280px,calc(var(--visual-viewport-height)*0.4))] min-h-0 overflow-auto rounded-md border border-border p-3">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy>
            <span className="sr-only">Loading Buildkite pipelines</span>
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
        ) : pipelinesQuery.isError ? (
          <InlineAlert variant="error">
            {pipelinesQuery.error instanceof Error
              ? pipelinesQuery.error.message
              : "Could not load Buildkite pipelines. Try again."}
          </InlineAlert>
        ) : listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pipelines found. Check the filter, or the organizations of the
            API access token.
          </p>
        ) : (
          <CheckboxGroup
            aria-label="Buildkite pipelines"
            value={selected}
            onChange={(slugs) =>
              // Keep the order of the selection, then add new picks at the end.
              update([
                ...selected.filter((slug) => slugs.includes(slug)),
                ...slugs.filter((slug) => !selected.includes(slug)),
              ])
            }
          >
            {listed.map((pipeline) => (
              <Checkbox key={pipeline.slug} value={pipeline.slug}>
                <span className="min-w-0 truncate">{pipeline.name}</span>
              </Checkbox>
            ))}
          </CheckboxGroup>
        )}
      </div>
      {pipelinesQuery.data?.truncated ? (
        <p className="text-sm text-muted-foreground">
          The organization has more pipelines than this list shows.
        </p>
      ) : null}
      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Select at least one pipeline.
        </p>
      ) : null}
      <ScopeLimitAlert
        schema={buildkiteSourceScopeSchema}
        scope={{ pipelines: selected }}
      />
    </section>
  )
}

/** Buildkite source UI: a filtered list of the organization's pipelines. */
export const buildkiteSourceUi: SourceProviderUi = {
  Icon: BuildkiteMark,
  ScopeEditor: BuildkiteScopeEditor,
}
