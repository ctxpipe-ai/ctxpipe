import { useState, useCallback, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { Checkbox } from "@/components/ui/Checkbox"
import {
  IconChevronRight,
  IconLoader2,
  IconSearch,
  IconStack2,
  IconFileText,
} from "@tabler/icons-react"

export interface SpaceScopeItem {
  spaceKey: string
  spaceName?: string
  selectedPageIds: string[] | null
}

interface ConfluenceSpace {
  id: string
  key: string
  name: string
  type: string
}

interface ConfluencePage {
  id: string
  title: string
  spaceId: string
  parentId?: string
}

// ---------------------------------------------------------------------------
// PageNode — lazy-loads children on expand
// ---------------------------------------------------------------------------

interface PageNodeProps {
  page: ConfluencePage
  connectorId: string
  orgSlug: string
  spaceKey: string
  selectedPageIds: string[] | null
  onTogglePage: (spaceKey: string, pageId: string, pageTitle: string) => void
  depth?: number
}

function PageNode({
  page,
  connectorId,
  orgSlug,
  spaceKey,
  selectedPageIds,
  onTogglePage,
  depth = 0,
}: PageNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [hasLoadedChildren, setHasLoadedChildren] = useState(false)

  const { data: children = [], isFetching, isError } = useQuery({
    queryKey: ["connector-child-pages", connectorId, spaceKey, page.id],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"][
        "available-spaces"
      ][":spaceKey"]["pages"].$get({
        param: { orgSlug, id: connectorId, spaceKey },
        query: { parentId: page.id },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      return (json as { items: ConfluencePage[] }).items
    },
    enabled: expanded,
    throwOnError: false,
  })

  useEffect(() => {
    if (!isFetching && expanded) setHasLoadedChildren(true)
  }, [isFetching, expanded])

  const isLeaf = hasLoadedChildren && children.length === 0
  const isSelected =
    selectedPageIds === null || selectedPageIds.includes(page.id)
  const isAllMode = selectedPageIds === null

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 rounded hover:bg-zinc-800/50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Expand chevron — invisible placeholder when confirmed leaf */}
        <button
          type="button"
          onClick={() => !isLeaf && setExpanded((v) => !v)}
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
          onChange={() => onTogglePage(spaceKey, page.id, page.title)}
          className={[
            "text-sm text-zinc-300",
            isAllMode ? "opacity-60" : "",
          ].join(" ")}
        >
          {page.title}
        </Checkbox>
      </div>

      {expanded && !isFetching && (
        <div>
          {isError && (
            <p
              className="py-1 text-xs text-red-400"
              style={{ paddingLeft: `${24 + depth * 16}px` }}
            >
              Failed to load subpages
            </p>
          )}
          {children.map((child) => (
            <PageNode
              key={child.id}
              page={child}
              connectorId={connectorId}
              orgSlug={orgSlug}
              spaceKey={spaceKey}
              selectedPageIds={selectedPageIds}
              onTogglePage={onTogglePage}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpaceNode — unified space row with inline page tree
// ---------------------------------------------------------------------------

interface SpaceNodeProps {
  space: ConfluenceSpace
  connectorId: string
  orgSlug: string
  scope: SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, pageTitle: string) => void
  search: string
}

function SpaceNode({
  space,
  connectorId,
  orgSlug,
  scope,
  onToggleSpace,
  onTogglePage,
  search,
}: SpaceNodeProps) {
  const [expanded, setExpanded] = useState(false)

  const isSelected = scope !== undefined
  const isAllPages = scope?.selectedPageIds === null
  const isSpecific =
    scope !== undefined && scope.selectedPageIds !== null
  const isSearching = search.trim().length > 0

  const checkboxState = !isSelected
    ? false
    : isAllPages
      ? true
      : "indeterminate"

  // Tree mode: top-level pages, loaded when expanded
  const { data: pages, isFetching: isFetchingPages } = useQuery({
    queryKey: ["connector-pages", connectorId, space.key],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"][
        "available-spaces"
      ][":spaceKey"]["pages"].$get({
        param: { orgSlug, id: connectorId, spaceKey: space.key },
        query: {},
      })
      if (!res.ok) throw new Error(`Failed to fetch pages (${res.status})`)
      const json = await res.json()
      return (json as { items: ConfluencePage[] }).items
    },
    enabled: expanded && !isSearching,
    throwOnError: false,
  })

  // Search mode: server-side CQL per space
  const { data: searchResults, isFetching: isFetchingSearch } = useQuery({
    queryKey: ["connector-page-search", connectorId, space.key, search],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"][
        "available-spaces"
      ][":spaceKey"]["search"].$get({
        param: { orgSlug, id: connectorId, spaceKey: space.key },
        query: { q: search },
      })
      if (!res.ok) throw new Error(`Failed to search pages (${res.status})`)
      const json = await res.json()
      return (json as { items: ConfluencePage[] }).items
    },
    enabled: isSearching,
    throwOnError: false,
  })

  const isFetching = isFetchingPages || isFetchingSearch
  const displayPages = isSearching ? (searchResults ?? []) : (pages ?? [])

  // Auto-expand space when it has search results
  const hasSearchResults = isSearching && (searchResults ?? []).length > 0
  const showPanel =
    expanded || (isSearching && (isFetchingSearch || hasSearchResults))

  const statusLabel = !isSelected
    ? null
    : isAllPages
      ? "all pages"
      : `${scope!.selectedPageIds!.length} page${scope!.selectedPageIds!.length === 1 ? "" : "s"}`

  return (
    <div className="border-b border-zinc-800 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-zinc-800/40">
        {/* Expand chevron */}
        <button
          type="button"
          onClick={() => !isSearching && setExpanded((v) => !v)}
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:text-zinc-300 transition-colors",
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

        {/* Space icon */}
        <IconStack2 className="h-4 w-4 shrink-0 text-zinc-400" />

        {/* Checkbox + label */}
        <Checkbox
          isSelected={isSelected}
          isIndeterminate={checkboxState === "indeterminate"}
          onChange={() => onToggleSpace(space)}
          className="flex-1 font-medium text-zinc-200"
        >
          <span className="flex items-center gap-2">
            {space.name}
            <span className="text-xs font-mono font-normal text-zinc-500">
              {space.key}
            </span>
          </span>
        </Checkbox>

        {/* Status / spinner */}
        {isFetchingSearch && (
          <IconLoader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" />
        )}
        {statusLabel && !isFetchingSearch && (
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
            {statusLabel}
          </span>
        )}
      </div>

      {/* Expanded page tree */}
      {showPanel && (
        <div className="border-t border-zinc-800/60 bg-zinc-800/20 pb-2">
          {/* "All pages" mode hint */}
          {isSelected && isAllPages && !isSearching && (
            <p className="px-4 pt-2 pb-1 text-xs text-zinc-600">
              All pages included.{" "}
              <span className="text-zinc-500">
                Click a page to select specific pages instead.
              </span>
            </p>
          )}

          {/* Specific pages mode hint */}
          {isSpecific && !isSearching && (
            <p className="px-4 pt-2 pb-1 text-xs text-zinc-600">
              Specific pages selected.{" "}
              <button
                type="button"
                className="text-teal-500 hover:text-teal-400"
                onClick={() => onToggleSpace(space)}
              >
                Switch to all pages
              </button>
            </p>
          )}

          {/* Loading */}
          {isFetching && displayPages.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500">
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
              {isSearching ? "Searching…" : "Loading pages…"}
            </div>
          )}

          {/* Empty state */}
          {!isFetching && displayPages.length === 0 && (
            <p className="px-4 py-2 text-xs text-zinc-600">
              {isSearching
                ? `No pages match "${search}".`
                : "No root-level pages found."}
            </p>
          )}

          {/* Page list */}
          {isSearching
            ? displayPages.map((page) => (
                <div
                  key={page.id}
                  className="flex items-center gap-1.5 py-1 pl-4 rounded hover:bg-zinc-800/50"
                >
                  <div className="h-5 w-5 shrink-0" />
                  <IconFileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <Checkbox
                    isSelected={
                      scope?.selectedPageIds === null ||
                      (scope?.selectedPageIds?.includes(page.id) ?? false)
                    }
                    onChange={() =>
                      onTogglePage(space.key, page.id, page.title)
                    }
                    className={[
                      "text-sm text-zinc-300",
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
                  connectorId={connectorId}
                  orgSlug={orgSlug}
                  spaceKey={space.key}
                  selectedPageIds={scope?.selectedPageIds ?? null}
                  onTogglePage={onTogglePage}
                />
              ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PersonalSpacesGroup — collapsed by default
// ---------------------------------------------------------------------------

interface PersonalSpacesGroupProps {
  spaces: ConfluenceSpace[]
  connectorId: string
  orgSlug: string
  search: string
  getScope: (key: string) => SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, pageTitle: string) => void
}

function PersonalSpacesGroup({
  spaces,
  connectorId,
  orgSlug,
  search,
  getScope,
  onToggleSpace,
  onTogglePage,
}: PersonalSpacesGroupProps) {
  const [open, setOpen] = useState(false)
  const selectedCount = spaces.filter((s) => getScope(s.key)).length

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800/40"
      >
        <span className="flex items-center gap-2">
          <IconChevronRight
            className={[
              "h-3.5 w-3.5 transition-transform duration-150",
              open ? "rotate-90" : "",
            ].join(" ")}
          />
          Personal spaces
          <span className="text-xs text-zinc-600">({spaces.length})</span>
        </span>
        {selectedCount > 0 && (
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-300">
            {selectedCount} selected
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-zinc-700/50">
          {spaces.map((space) => (
            <SpaceNode
              key={space.id}
              space={space}
              connectorId={connectorId}
              orgSlug={orgSlug}
              scope={getScope(space.key)}
              onToggleSpace={onToggleSpace}
              onTogglePage={onTogglePage}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpacePageTree — root component
// ---------------------------------------------------------------------------

interface SpacePageTreeProps {
  connectorId: string
  orgSlug: string
  value: SpaceScopeItem[]
  onChange: (value: SpaceScopeItem[]) => void
}

export function SpacePageTree({
  connectorId,
  orgSlug,
  value,
  onChange,
}: SpacePageTreeProps) {
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const { data: spaces, isLoading, error } = useQuery({
    queryKey: ["connector-available-spaces", connectorId],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"][
        "available-spaces"
      ].$get({
        param: { orgSlug, id: connectorId },
      })
      if (!res.ok) throw new Error("Failed to fetch spaces")
      const json = await res.json()
      return (json as { items: ConfluenceSpace[] }).items
    },
    throwOnError: false,
  })

  const getScope = useCallback(
    (spaceKey: string) => value.find((s) => s.spaceKey === spaceKey),
    [value],
  )

  // Space checkbox: not selected → all pages → not selected
  //                 specific pages → all pages (on click)
  const handleToggleSpace = useCallback(
    (space: ConfluenceSpace) => {
      const existing = value.find((s) => s.spaceKey === space.key)
      if (!existing) {
        onChange([
          ...value,
          { spaceKey: space.key, spaceName: space.name, selectedPageIds: null },
        ])
      } else if (existing.selectedPageIds !== null) {
        // Specific pages → revert to all pages
        onChange(
          value.map((s) =>
            s.spaceKey === space.key ? { ...s, selectedPageIds: null } : s,
          ),
        )
      } else {
        // All pages → remove
        onChange(value.filter((s) => s.spaceKey !== space.key))
      }
    },
    [value, onChange],
  )

  const handleTogglePage = useCallback(
    (spaceKey: string, pageId: string, _pageTitle: string) => {
      onChange(
        value.map((s) => {
          if (s.spaceKey !== spaceKey) return s
          if (s.selectedPageIds === null) {
            // Switch from "all pages" to specific, starting with just this page
            return { ...s, selectedPageIds: [pageId] }
          }
          const alreadySelected = s.selectedPageIds.includes(pageId)
          return {
            ...s,
            selectedPageIds: alreadySelected
              ? s.selectedPageIds.filter((id) => id !== pageId)
              : [...s.selectedPageIds, pageId],
          }
        }),
      )
    },
    [value, onChange],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
        <IconLoader2 className="h-4 w-4 animate-spin" />
        Loading spaces…
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

  const globalSpaces = spaces.filter((s) => !s.key.startsWith("~"))
  const personalSpaces = spaces.filter((s) => s.key.startsWith("~"))

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Single search bar */}
      <div className="relative shrink-0">
        <IconSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          placeholder="Search spaces and pages…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-3 text-sm text-zinc-200 placeholder-zinc-600 focus:border-teal-500 focus:outline-none"
        />
      </div>

      {/* Tree */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 overflow-hidden">
          {globalSpaces.length === 0 && (
            <p className="px-3 py-2 text-sm text-zinc-500">
              No team spaces found.
            </p>
          )}
          {globalSpaces.map((space) => (
            <SpaceNode
              key={space.id}
              space={space}
              connectorId={connectorId}
              orgSlug={orgSlug}
              scope={getScope(space.key)}
              onToggleSpace={handleToggleSpace}
              onTogglePage={handleTogglePage}
              search={debouncedSearch}
            />
          ))}
        </div>

        {personalSpaces.length > 0 && (
          <PersonalSpacesGroup
            spaces={personalSpaces}
            connectorId={connectorId}
            orgSlug={orgSlug}
            search={debouncedSearch}
            getScope={getScope}
            onToggleSpace={handleToggleSpace}
            onTogglePage={handleTogglePage}
          />
        )}
      </div>
    </div>
  )
}
