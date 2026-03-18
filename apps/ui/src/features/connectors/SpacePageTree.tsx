import { useState, useCallback, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { Checkbox } from "@/components/ui/Checkbox"
import { IconChevronRight, IconLoader2, IconSearch } from "@tabler/icons-react"

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
// PageNode — lazy-loads children on expand; hides chevron when leaf confirmed
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

  const isSelected =
    selectedPageIds === null || selectedPageIds.includes(page.id)

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 rounded hover:bg-zinc-800/50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:text-zinc-300"
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

        <Checkbox
          isSelected={isSelected}
          onChange={() => onTogglePage(spaceKey, page.id, page.title)}
          className="text-sm text-zinc-300"
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
// SpaceRow — space checkbox + expandable page list (browse without selecting)
// ---------------------------------------------------------------------------

interface SpaceRowProps {
  space: ConfluenceSpace
  connectorId: string
  orgSlug: string
  scope: SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, pageTitle: string) => void
  pageSearch: string
}

function SpaceRow({
  space,
  connectorId,
  orgSlug,
  scope,
  onToggleSpace,
  onTogglePage,
  pageSearch,
}: SpaceRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isSpaceSelected = scope !== undefined
  const isPersonal = space.key.startsWith("~")
  const isSearching = pageSearch.trim().length > 0

  // Tree mode: top-level pages for browsing
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

  // Search mode: server-side CQL search — fires for all spaces when query is active
  const { data: searchResults, isFetching: isFetchingSearch } = useQuery({
    queryKey: ["connector-page-search", connectorId, space.key, pageSearch],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"][
        "available-spaces"
      ][":spaceKey"]["search"].$get({
        param: { orgSlug, id: connectorId, spaceKey: space.key },
        query: { q: pageSearch },
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

  const spaceCheckboxState = !isSpaceSelected
    ? false
    : scope?.selectedPageIds === null
      ? true
      : "indeterminate"

  // Show the pages panel when manually expanded, or in search mode only if
  // there are results or a search is in-flight (avoids opening all 52 space
  // panels when nothing matches — that buries the actual results).
  const showPanel =
    expanded || (isSearching && (isFetchingSearch || (searchResults ?? []).length > 0))

  return (
    <div className="border-b border-zinc-800 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-zinc-800/40">
        <Checkbox
          isSelected={isSpaceSelected}
          isIndeterminate={spaceCheckboxState === "indeterminate"}
          onChange={() => onToggleSpace(space)}
          className="flex-1 font-medium text-zinc-200"
        >
          <span className="flex items-center gap-2">
            {space.name}
            {isPersonal ? (
              <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400">
                Personal
              </span>
            ) : (
              <span className="text-xs font-mono text-zinc-500">{space.key}</span>
            )}
          </span>
        </Checkbox>

        {/* Only show browse button when not in search mode */}
        {!isSearching && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto flex shrink-0 items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
            aria-label={expanded ? "Collapse pages" : "Browse pages"}
          >
            {isFetchingPages ? (
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <span>{expanded ? "Hide pages" : "Browse pages"}</span>
                <IconChevronRight
                  className={[
                    "h-3.5 w-3.5 transition-transform duration-150",
                    expanded ? "rotate-90" : "",
                  ].join(" ")}
                />
              </>
            )}
          </button>
        )}

        {/* In search mode show a spinner inline if fetching */}
        {isSearching && isFetchingSearch && (
          <IconLoader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" />
        )}
      </div>

      {showPanel && (
        <div className="border-t border-zinc-800/60 bg-zinc-800/20 pb-2">
          {/* Select all / none controls */}
          <div className="flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              className="text-xs text-teal-400 hover:text-teal-300"
              onClick={() => {
                if (!isSpaceSelected) {
                  // Add space with selectedPageIds:null = "all pages" in one update.
                  // Cannot call onTogglePage next — React batches both setScope calls
                  // and the second (which uses stale value) would overwrite the first.
                  onToggleSpace(space)
                } else {
                  onTogglePage(space.key, "__all__", "")
                }
              }}
            >
              Select all
            </button>
            <span className="text-zinc-600">·</span>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-zinc-300"
              onClick={() => {
                if (isSpaceSelected) onTogglePage(space.key, "__none__", "")
              }}
            >
              Deselect all
            </button>

            {/* Status label */}
            <span className="ml-auto text-xs text-zinc-500">
              {!isSpaceSelected
                ? "not included"
                : scope?.selectedPageIds === null
                  ? "all pages"
                  : `${scope.selectedPageIds.length} selected`}
            </span>
          </div>

          {/* Help text when in "all pages" mode so individual checkboxes aren't confusing */}
          {isSpaceSelected && scope?.selectedPageIds === null && (
            <p className="px-3 pb-1 text-xs text-zinc-600">
              All pages synced. Use <span className="text-zinc-400">Deselect all</span> to choose specific pages.
            </p>
          )}

          {(isSearching ? isFetchingSearch : isFetchingPages) && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
              {isSearching ? "Searching…" : "Loading pages…"}
            </div>
          )}

          {!isFetching && displayPages.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-600">
              {isSearching ? `No pages match "${pageSearch}".` : "No root-level pages found."}
            </p>
          )}

          {/* In search mode: flat results list. In tree mode: PageNode tree. */}
          {isSearching
            ? displayPages.map((page) => (
                <div
                  key={page.id}
                  className="flex items-center gap-1.5 py-1 pl-3 rounded hover:bg-zinc-800/50"
                >
                  <div className="h-5 w-5 shrink-0" />
                  <Checkbox
                    isSelected={scope?.selectedPageIds === null || (scope?.selectedPageIds?.includes(page.id) ?? false)}
                    onChange={() => onTogglePage(space.key, page.id, page.title)}
                    className="text-sm text-zinc-300"
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
  pageSearch: string
  getScope: (key: string) => SpaceScopeItem | undefined
  onToggleSpace: (space: ConfluenceSpace) => void
  onTogglePage: (spaceKey: string, pageId: string, pageTitle: string) => void
}

function PersonalSpacesGroup({
  spaces,
  connectorId,
  orgSlug,
  pageSearch,
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
            <SpaceRow
              key={space.id}
              space={space}
              connectorId={connectorId}
              orgSlug={orgSlug}
              scope={getScope(space.key)}
              onToggleSpace={onToggleSpace}
              onTogglePage={onTogglePage}
              pageSearch={pageSearch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpacePageTree — search + space list
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
  const [spaceSearch, setSpaceSearch] = useState("")
  const [pageSearch, setPageSearch] = useState("")
  const [debouncedPageSearch, setDebouncedPageSearch] = useState("")

  useEffect(() => {
    const id = setTimeout(() => setDebouncedPageSearch(pageSearch), 300)
    return () => clearTimeout(id)
  }, [pageSearch])

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

  const handleToggleSpace = useCallback(
    (space: ConfluenceSpace) => {
      const existing = value.find((s) => s.spaceKey === space.key)
      if (existing) {
        onChange(value.filter((s) => s.spaceKey !== space.key))
      } else {
        onChange([
          ...value,
          { spaceKey: space.key, spaceName: space.name, selectedPageIds: null },
        ])
      }
    },
    [value, onChange],
  )

  const handleTogglePage = useCallback(
    (spaceKey: string, pageId: string, _pageTitle: string) => {
      if (pageId === "__all__") {
        onChange(
          value.map((s) =>
            s.spaceKey === spaceKey ? { ...s, selectedPageIds: null } : s,
          ),
        )
        return
      }
      if (pageId === "__none__") {
        onChange(
          value.map((s) =>
            s.spaceKey === spaceKey ? { ...s, selectedPageIds: [] } : s,
          ),
        )
        return
      }

      onChange(
        value.map((s) => {
          if (s.spaceKey !== spaceKey) return s
          if (s.selectedPageIds === null) return s
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

  const filteredGlobal = spaceSearch
    ? globalSpaces.filter(
        (s) =>
          s.name.toLowerCase().includes(spaceSearch.toLowerCase()) ||
          s.key.toLowerCase().includes(spaceSearch.toLowerCase()),
      )
    : globalSpaces

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <IconSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search spaces…"
            value={spaceSearch}
            onChange={(e) => setSpaceSearch(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-3 text-sm text-zinc-200 placeholder-zinc-600 focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div className="relative flex-1">
          <IconSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Filter pages…"
            value={pageSearch}
            onChange={(e) => setPageSearch(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 py-1.5 pl-8 pr-3 text-sm text-zinc-200 placeholder-zinc-600 focus:border-teal-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Space list */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/30 overflow-hidden">
          {filteredGlobal.length === 0 && (
            <p className="px-3 py-2 text-sm text-zinc-500">
              {spaceSearch ? "No spaces match." : "No team spaces found."}
            </p>
          )}
          {filteredGlobal.map((space) => (
            <SpaceRow
              key={space.id}
              space={space}
              connectorId={connectorId}
              orgSlug={orgSlug}
              scope={getScope(space.key)}
              onToggleSpace={handleToggleSpace}
              onTogglePage={handleTogglePage}
              pageSearch={debouncedPageSearch}
            />
          ))}
        </div>

        {personalSpaces.length > 0 && !spaceSearch && (
          <PersonalSpacesGroup
            spaces={personalSpaces}
            connectorId={connectorId}
            orgSlug={orgSlug}
            pageSearch={debouncedPageSearch}
            getScope={getScope}
            onToggleSpace={handleToggleSpace}
            onTogglePage={handleTogglePage}
          />
        )}
      </div>
    </div>
  )
}
