import {
  IconChevronRight,
  IconFileText,
  IconLoader2,
  IconSearch,
  IconStack2,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { Checkbox } from "@/components/ui/Checkbox"
import type { ConfluencePage, ConfluenceSpace, SpaceScopeItem } from "./types"

function connectorsAtlassianUrl(
  orgSlug: string,
  suffix: string,
  atlassianConnectionId: string | undefined,
  params?: Record<string, string>,
) {
  const p = new URLSearchParams(params ?? {})
  if (atlassianConnectionId) p.set("connectionId", atlassianConnectionId)
  const qs = p.toString()
  const path = `/${orgSlug}/api/v1/connectors/atlassian${suffix}`
  return qs ? `${path}?${qs}` : path
}

/** `undefined` = space not in scope; `null` = all pages in space; array = specific pages */
type PageScopeSelection = string[] | null | undefined

interface PageNodeProps {
  page: ConfluencePage
  orgSlug: string
  atlassianConnectionId: string | undefined
  spaceKey: string
  spaceName?: string
  selectedPageIds: PageScopeSelection
  onTogglePage: (spaceKey: string, pageId: string, spaceName?: string) => void
  depth?: number
}

function PageNode({
  page,
  orgSlug,
  atlassianConnectionId,
  spaceKey,
  spaceName,
  selectedPageIds,
  onTogglePage,
  depth = 0,
}: PageNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [hasLoadedChildren, setHasLoadedChildren] = useState(false)

  const {
    data: children = [],
    isFetching,
    isError,
  } = useQuery({
    queryKey: [
      "atlassian-child-pages",
      orgSlug,
      atlassianConnectionId ?? "default",
      spaceKey,
      page.id,
    ],
    queryFn: async () => {
      const res = await fetch(
        connectorsAtlassianUrl(
          orgSlug,
          `/available-spaces/${encodeURIComponent(spaceKey)}/pages`,
          atlassianConnectionId,
          { parentId: page.id },
        ),
        { credentials: "include" },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { items: ConfluencePage[] }
      return json.items
    },
    enabled: expanded,
    throwOnError: false,
  })

  useEffect(() => {
    if (!isFetching && expanded) setHasLoadedChildren(true)
  }, [isFetching, expanded])

  const isLeaf = hasLoadedChildren && children.length === 0
  const isSpaceInScope = selectedPageIds !== undefined
  const isSelected =
    isSpaceInScope &&
    (selectedPageIds === null || selectedPageIds.includes(page.id))
  const isAllMode = selectedPageIds === null

  return (
    <div>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded py-1 hover:bg-zinc-800/50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => !isLeaf && setExpanded((value) => !value)}
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:text-zinc-300",
            isLeaf ? "pointer-events-none opacity-0" : "",
          ].join(" ")}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {isFetching ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconChevronRight
              className={[
                "h-3.5 w-3.5 transition-transform duration-150",
                expanded ? "rotate-90" : "",
              ].join(" ")}
            />
          )}
        </button>

        <IconFileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />

        <Checkbox
          isSelected={isSelected}
          onChange={() => onTogglePage(spaceKey, page.id, spaceName)}
          className={[
            "min-w-0 flex-1 text-sm wrap-break-word text-zinc-300",
            isAllMode ? "opacity-60" : "",
          ].join(" ")}
        >
          {page.title}
        </Checkbox>
      </div>

      {expanded && !isFetching ? (
        <div>
          {isError ? (
            <p
              className="py-1 text-xs text-red-400"
              style={{ paddingLeft: `${24 + depth * 16}px` }}
            >
              Failed to load subpages
            </p>
          ) : null}
          {children.map((child) => (
            <PageNode
              key={child.id}
              page={child}
              orgSlug={orgSlug}
              atlassianConnectionId={atlassianConnectionId}
              spaceKey={spaceKey}
              spaceName={spaceName}
              selectedPageIds={selectedPageIds}
              onTogglePage={onTogglePage}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface SpaceNodeProps {
  space: ConfluenceSpace
  orgSlug: string
  atlassianConnectionId: string | undefined
  scope: SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, spaceName?: string) => void
  search: string
}

function SpaceNode({
  space,
  orgSlug,
  atlassianConnectionId,
  scope,
  onToggleSpace,
  onTogglePage,
  search,
}: SpaceNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const isSelected = scope !== undefined
  const isAllPages = scope?.selectedPageIds === null
  const isSpecific = scope !== undefined && scope.selectedPageIds !== null
  const isSearching = search.trim().length > 0

  const checkboxState = !isSelected
    ? false
    : isAllPages
      ? true
      : "indeterminate"

  const { data: pages, isFetching: isFetchingPages } = useQuery({
    queryKey: [
      "atlassian-pages",
      orgSlug,
      atlassianConnectionId ?? "default",
      space.key,
    ],
    queryFn: async () => {
      const res = await fetch(
        connectorsAtlassianUrl(
          orgSlug,
          `/available-spaces/${encodeURIComponent(space.key)}/pages`,
          atlassianConnectionId,
        ),
        { credentials: "include" },
      )
      if (!res.ok) throw new Error(`Failed to fetch pages (${res.status})`)
      const json = (await res.json()) as { items: ConfluencePage[] }
      return json.items
    },
    enabled: expanded && !isSearching,
    throwOnError: false,
  })

  const { data: searchResults, isFetching: isFetchingSearch } = useQuery({
    queryKey: [
      "atlassian-page-search",
      orgSlug,
      atlassianConnectionId ?? "default",
      space.key,
      search,
    ],
    queryFn: async () => {
      const res = await fetch(
        connectorsAtlassianUrl(
          orgSlug,
          `/available-spaces/${encodeURIComponent(space.key)}/search`,
          atlassianConnectionId,
          { q: search },
        ),
        { credentials: "include" },
      )
      if (!res.ok) throw new Error(`Failed to search pages (${res.status})`)
      const json = (await res.json()) as { items: ConfluencePage[] }
      return json.items
    },
    enabled: isSearching,
    throwOnError: false,
  })

  const isFetching = isFetchingPages || isFetchingSearch
  const displayPages = isSearching ? (searchResults ?? []) : (pages ?? [])
  const hasSearchResults = isSearching && (searchResults ?? []).length > 0
  const showPanel =
    expanded || (isSearching && (isFetchingSearch || hasSearchResults))
  const statusLabel = !isSelected
    ? null
    : isAllPages
      ? "all pages"
      : `${scope?.selectedPageIds?.length ?? 0} page${(scope?.selectedPageIds?.length ?? 0) === 1 ? "" : "s"}`

  return (
    <div className="border-b border-zinc-800 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2.5 hover:bg-zinc-800/40">
        <button
          type="button"
          onClick={() => !isSearching && setExpanded((value) => !value)}
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:text-zinc-300",
            isSearching ? "pointer-events-none opacity-30" : "",
          ].join(" ")}
          aria-label={expanded ? "Collapse" : "Expand pages"}
        >
          {isFetchingPages && !isSearching ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconChevronRight
              className={[
                "h-3.5 w-3.5 transition-transform duration-150",
                showPanel ? "rotate-90" : "",
              ].join(" ")}
            />
          )}
        </button>

        <IconStack2 className="h-4 w-4 shrink-0 text-zinc-400" />

        <Checkbox
          isSelected={isSelected}
          isIndeterminate={checkboxState === "indeterminate"}
          onChange={() => onToggleSpace(space)}
          className="min-w-0 flex-1 font-medium text-zinc-200"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 wrap-break-word">
            <span className="min-w-0">{space.name}</span>
            <span className="shrink-0 text-xs font-mono font-normal text-zinc-500">
              {space.key}
            </span>
          </span>
        </Checkbox>

        {isFetchingSearch ? (
          <IconLoader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" />
        ) : null}
        {statusLabel && !isFetchingSearch ? (
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
            {statusLabel}
          </span>
        ) : null}
      </div>

      {showPanel ? (
        <div className="border-t border-zinc-800/60 bg-zinc-800/20 pb-2">
          {isSelected && isAllPages && !isSearching ? (
            <p className="px-4 pb-1 pt-2 text-xs text-zinc-600">
              All pages included.{" "}
              <span className="text-zinc-500">
                Click a page to select specific pages instead.
              </span>
            </p>
          ) : null}

          {isSpecific && !isSearching ? (
            <p className="px-4 pb-1 pt-2 text-xs text-zinc-600">
              Specific pages selected.{" "}
              <button
                type="button"
                className="text-teal-500 hover:text-teal-400"
                onClick={() => onToggleSpace(space)}
              >
                Switch to all pages
              </button>
            </p>
          ) : null}

          {isFetching && displayPages.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500">
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
              {isSearching ? "Searching..." : "Loading pages..."}
            </div>
          ) : null}

          {!isFetching && displayPages.length === 0 ? (
            <p className="px-4 py-2 text-xs text-zinc-600">
              {isSearching
                ? `No pages match "${search}".`
                : "No root-level pages found."}
            </p>
          ) : null}

          {isSearching
            ? displayPages.map((page) => (
                <div
                  key={page.id}
                  className="flex min-w-0 items-center gap-1.5 rounded py-1 pl-4 hover:bg-zinc-800/50"
                >
                  <div className="h-5 w-5 shrink-0" />
                  <IconFileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <Checkbox
                    isSelected={
                      scope !== undefined &&
                      (scope.selectedPageIds === null ||
                        scope.selectedPageIds.includes(page.id))
                    }
                    onChange={() =>
                      onTogglePage(space.key, page.id, space.name)
                    }
                    className={[
                      "min-w-0 flex-1 wrap-break-word text-sm text-zinc-300",
                      isAllPages ? "opacity-60" : "",
                    ].join(" ")}
                  >
                    {page.title}
                  </Checkbox>
                </div>
              ))
            : displayPages.map((page) => (
                <PageNode
                  key={page.id}
                  page={page}
                  orgSlug={orgSlug}
                  atlassianConnectionId={atlassianConnectionId}
                  spaceKey={space.key}
                  spaceName={space.name}
                  selectedPageIds={scope?.selectedPageIds}
                  onTogglePage={onTogglePage}
                />
              ))}
        </div>
      ) : null}
    </div>
  )
}

interface PersonalSpacesGroupProps {
  spaces: ConfluenceSpace[]
  orgSlug: string
  atlassianConnectionId: string | undefined
  search: string
  getScope: (spaceKey: string) => SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, spaceName?: string) => void
}

function PersonalSpacesGroup({
  spaces,
  orgSlug,
  atlassianConnectionId,
  search,
  getScope,
  onToggleSpace,
  onTogglePage,
}: PersonalSpacesGroupProps) {
  const [open, setOpen] = useState(false)
  const selectedCount = spaces.filter((space) => getScope(space.key)).length

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700/50 bg-zinc-800/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center justify-between gap-2 px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <IconChevronRight
            className={[
              "h-3.5 w-3.5 transition-transform duration-150",
              open ? "rotate-90" : "",
            ].join(" ")}
          />
          Personal spaces
          <span className="text-xs text-zinc-600">({spaces.length})</span>
        </span>
        {selectedCount > 0 ? (
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-300">
            {selectedCount} selected
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-t border-zinc-700/50">
          {spaces.map((space) => (
            <SpaceNode
              key={space.id}
              space={space}
              orgSlug={orgSlug}
              atlassianConnectionId={atlassianConnectionId}
              scope={getScope(space.key)}
              onToggleSpace={onToggleSpace}
              onTogglePage={onTogglePage}
              search={search}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface SpacePageTreeProps {
  orgSlug: string
  /** Forge / Confluence connection row to scope Atlassian API calls. */
  atlassianConnectionId?: string
  value: SpaceScopeItem[]
  onChange: (value: SpaceScopeItem[]) => void
}

export function SpacePageTree({
  orgSlug,
  atlassianConnectionId,
  value,
  onChange,
}: SpacePageTreeProps) {
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const {
    data: spaces,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      "atlassian-available-spaces",
      orgSlug,
      atlassianConnectionId ?? "default",
    ],
    queryFn: async () => {
      const res = await fetch(
        connectorsAtlassianUrl(orgSlug, "/available-spaces", atlassianConnectionId),
        {
          credentials: "include",
        },
      )
      if (!res.ok) throw new Error("Failed to fetch spaces")
      const json = (await res.json()) as { items: ConfluenceSpace[] }
      return json.items
    },
    throwOnError: false,
  })

  const getScope = useCallback(
    (spaceKey: string) => value.find((item) => item.spaceKey === spaceKey),
    [value],
  )

  const handleToggleSpace = useCallback(
    (space: ConfluenceSpace) => {
      const existing = value.find((item) => item.spaceKey === space.key)
      if (!existing) {
        onChange([
          ...value,
          { spaceKey: space.key, spaceName: space.name, selectedPageIds: null },
        ])
        return
      }
      if (existing.selectedPageIds !== null) {
        onChange(
          value.map((item) =>
            item.spaceKey === space.key
              ? { ...item, selectedPageIds: null }
              : item,
          ),
        )
        return
      }
      onChange(value.filter((item) => item.spaceKey !== space.key))
    },
    [value, onChange],
  )

  const handleTogglePage = useCallback(
    (spaceKey: string, pageId: string, spaceName?: string) => {
      const existing = value.find((item) => item.spaceKey === spaceKey)
      if (!existing) {
        onChange([
          ...value,
          {
            spaceKey,
            ...(spaceName !== undefined ? { spaceName } : {}),
            selectedPageIds: [pageId],
          },
        ])
        return
      }
      onChange(
        value.flatMap((item) => {
          if (item.spaceKey !== spaceKey) return [item]
          if (item.selectedPageIds === null) {
            return [{ ...item, selectedPageIds: [pageId] }]
          }
          const alreadySelected = item.selectedPageIds.includes(pageId)
          const nextIds = alreadySelected
            ? item.selectedPageIds.filter((id) => id !== pageId)
            : [...item.selectedPageIds, pageId]
          if (nextIds.length === 0) return []
          return [{ ...item, selectedPageIds: nextIds }]
        }),
      )
    },
    [value, onChange],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
        <IconLoader2 className="h-4 w-4 animate-spin" />
        Loading spaces...
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-red-400">
        {error instanceof Error ? error.message : "Failed to load spaces"}
      </p>
    )
  }

  if (!spaces?.length) {
    return <p className="text-sm text-zinc-400">No Confluence spaces found.</p>
  }

  const globalSpaces = spaces.filter((space) => !space.key.startsWith("~"))
  const personalSpaces = spaces.filter((space) => space.key.startsWith("~"))

  return (
    <div className="flex h-full min-w-0 flex-col gap-3">
      <div className="relative shrink-0">
        <IconSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          placeholder="Search spaces and pages..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-3 text-sm text-zinc-200 placeholder-zinc-600 focus:border-teal-500 focus:outline-none"
        />
      </div>

      <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto">
        <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800/30">
          {globalSpaces.length === 0 ? (
            <p className="px-3 py-2 text-sm text-zinc-500">
              No team spaces found.
            </p>
          ) : null}
          {globalSpaces.map((space) => (
            <SpaceNode
              key={space.id}
              space={space}
              orgSlug={orgSlug}
              atlassianConnectionId={atlassianConnectionId}
              scope={getScope(space.key)}
              onToggleSpace={handleToggleSpace}
              onTogglePage={handleTogglePage}
              search={debouncedSearch}
            />
          ))}
        </div>

        {personalSpaces.length > 0 ? (
          <PersonalSpacesGroup
            spaces={personalSpaces}
            orgSlug={orgSlug}
            atlassianConnectionId={atlassianConnectionId}
            search={debouncedSearch}
            getScope={getScope}
            onToggleSpace={handleToggleSpace}
            onTogglePage={handleTogglePage}
          />
        ) : null}
      </div>
    </div>
  )
}
