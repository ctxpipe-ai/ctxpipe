import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { Dialog } from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import {
  prefetchOrgConnectors,
  prefetchOrgHome,
} from "@/components/SideNav/prefetch-org-pages"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { SkeletonRow } from "@/components/ui/Skeleton"
import { prefetchWorkspaceRouteData } from "./ensure-route-data"
import { fetchWorkspaces, workspaceKeys } from "./queries"

export function WorkspaceCommandPalette(props: {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open?: boolean) => void
  onSelectNav?: (next: SideNavLocation) => void
}) {
  const { orgSlug, isOpen, onOpenChange } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const contextSelectNav = useSelectNav()
  const selectNav = props.onSelectNav ?? contextSelectNav
  const [query, setQuery] = useState("")
  const workspacesQuery = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
    enabled: isOpen,
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        onOpenChange(!isOpen)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isOpen, onOpenChange])

  const items = useMemo(() => {
    const workspaces = (workspacesQuery.data?.items ?? []).map((workspace) => ({
      id: `ws:${workspace.slug}`,
      label: workspace.displayName,
      hint: workspace.slug,
    }))
    const all = [
      { id: "home", label: "Home", hint: "page" },
      { id: "connectors", label: "Connectors", hint: "page" },
      ...workspaces,
    ]
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.hint.toLowerCase().includes(needle),
    )
  }, [query, workspacesQuery.data?.items])

  const go = (id: string) => {
    if (id === "home") {
      prefetchOrgHome(queryClient, orgSlug)
      selectNav({ orgSlug, primary: "home" })
      void navigate({
        to: "/$orgSlug",
        params: { orgSlug },
        search: (prev) => prev,
      })
    } else if (id === "connectors") {
      prefetchOrgConnectors(queryClient, orgSlug)
      selectNav({ orgSlug, primary: "connectors" })
      void navigate({
        to: "/$orgSlug/connectors",
        params: { orgSlug },
        search: (prev) => ({
          ...prev,
          error: undefined,
          error_description: undefined,
          pendingAccountClaim: undefined,
          notionConnectionId: undefined,
        }),
      })
    } else if (id.startsWith("ws:")) {
      const workspaceSlug = id.slice(3)
      prefetchWorkspaceRouteData({
        queryClient,
        orgSlug,
        workspaceSlug,
        warmLandingPane: true,
      })
      selectNav({
        orgSlug,
        primary: "workspace",
        workspaceSlug,
      })
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug",
        params: { orgSlug, workspaceSlug },
        search: (prev) => prev,
      })
    }
    onOpenChange(false)
    setQuery("")
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Dialog className="flex max-h-[inherit] flex-col p-3">
        <SearchField
          autoFocus
          aria-label="Search"
          placeholder="Jump to…"
          value={query}
          onChange={setQuery}
        />
        <ul className="mt-2 max-h-80 overflow-auto">
          {isOpen && workspacesQuery.isPending && !workspacesQuery.data ? (
            <li aria-busy>
              <span className="sr-only">Loading workspaces</span>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </li>
          ) : items.length === 0 ? (
            <li className="px-2 py-2 text-sm text-muted-foreground">
              No results found.
            </li>
          ) : (
            items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-900"
                  onClick={() => go(item.id)}
                >
                  <span>{item.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </Dialog>
    </Modal>
  )
}
