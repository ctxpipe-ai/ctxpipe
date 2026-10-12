import { IconFolder, IconHome, IconPlug } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import {
  Autocomplete,
  Header,
  type Key,
  MenuSection,
  useFilter,
} from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import {
  prefetchOrgConnectors,
  prefetchOrgHome,
} from "@/components/SideNav/prefetch-org-pages"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { Dialog } from "@/components/ui/Dialog"
import { Menu, MenuItem } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { SkeletonRow, useSkeletonHold } from "@/components/ui/Skeleton"
import { prefetchWorkspaceRouteData } from "./ensure-route-data"
import { fetchWorkspaces, workspaceKeys } from "./queries"

type PaletteProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open?: boolean) => void
  onSelectNav?: (next: SideNavLocation) => void
}

const sectionLabelClassName = "ctx-label px-3 pt-2 pb-1"

/**
 * Cmd+K / Ctrl+K palette: go to a workspace, Home, or Connectors.
 * React Aria Autocomplete keeps focus in the search field and moves a virtual
 * focus through the menu, so arrow keys move, Enter runs, and Escape clears
 * the search before it closes the dialog.
 */
export function WorkspaceCommandPalette(props: PaletteProps) {
  const { isOpen, onOpenChange } = props

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        onOpenChange(!isOpen)
      }
    }
    // Capture phase: React Aria stops key events in the open dialog.
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [isOpen, onOpenChange])

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      placement="top"
      size="medium"
    >
      <Dialog aria-label="Command palette" className="flex flex-col p-0">
        {/* The Modal unmounts this body on close, so the search starts empty. */}
        <PaletteBody {...props} />
      </Dialog>
    </Modal>
  )
}

function PaletteBody(props: PaletteProps) {
  const { orgSlug, onOpenChange } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const contextSelectNav = useSelectNav()
  const selectNav = props.onSelectNav ?? contextSelectNav
  const [query, setQuery] = useState("")
  const { contains } = useFilter({ sensitivity: "base" })
  const workspacesQuery = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const workspacesLoading = useSkeletonHold(
    workspacesQuery.isPending && !workspacesQuery.data,
  )
  const workspaces = workspacesQuery.data?.items ?? []

  const run = (key: Key) => {
    const id = String(key)
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
      selectNav({ orgSlug, primary: "workspace", workspaceSlug })
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug",
        params: { orgSlug, workspaceSlug },
        search: (prev) => prev,
      })
    }
    onOpenChange(false)
  }

  return (
    <Autocomplete
      inputValue={query}
      onInputChange={setQuery}
      filter={(textValue, input, node) =>
        contains(textValue, input) ||
        (typeof node.key === "string" &&
          node.key.startsWith("ws:") &&
          contains(node.key.slice(3), input))
      }
    >
      <div className="border-b border-white/10 p-2">
        <SearchField
          autoFocus
          aria-label="Search workspaces and pages"
          placeholder="Search workspaces and pages"
        />
      </div>
      <div className="max-h-96 overflow-y-auto p-1">
        {workspacesLoading ? (
          <section aria-busy aria-label="Loading workspaces">
            <div aria-hidden className={sectionLabelClassName}>
              Workspaces
            </div>
            <SkeletonRow className="h-9 px-3" />
            <SkeletonRow className="h-9 px-3" />
            <SkeletonRow className="h-9 px-3" />
          </section>
        ) : workspacesQuery.isError ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            Workspaces did not load. Close and open the palette to try again.
          </p>
        ) : null}
        <Menu
          aria-label="Results"
          onAction={run}
          className="max-h-none overflow-visible p-0"
          renderEmptyState={() =>
            workspacesLoading ? null : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No results for “<span className="text-foreground">{query}</span>
                ”
              </p>
            )
          }
        >
          {workspaces.length > 0 ? (
            <MenuSection>
              <Header className={sectionLabelClassName}>Workspaces</Header>
              {workspaces.map((workspace) => (
                <PaletteItem
                  key={workspace.slug}
                  id={`ws:${workspace.slug}`}
                  textValue={workspace.displayName}
                  icon={<IconFolder stroke={1.4} />}
                  hint={workspace.slug}
                >
                  {workspace.displayName}
                </PaletteItem>
              ))}
            </MenuSection>
          ) : null}
          <MenuSection>
            <Header className={sectionLabelClassName}>Pages</Header>
            <PaletteItem
              id="home"
              textValue="Home"
              icon={<IconHome stroke={1.4} />}
            >
              Home
            </PaletteItem>
            <PaletteItem
              id="connectors"
              textValue="Connectors"
              icon={<IconPlug stroke={1.4} />}
            >
              Connectors
            </PaletteItem>
          </MenuSection>
        </Menu>
      </div>
      <div
        aria-hidden
        className="flex gap-4 border-t border-white/10 px-3 py-2 text-xs text-muted-foreground"
      >
        <span>
          <kbd className="font-mono text-foreground">↑↓</kbd> Move
        </span>
        <span>
          <kbd className="font-mono text-foreground">Enter</kbd> Open
        </span>
        <span>
          <kbd className="font-mono text-foreground">Esc</kbd> Close
        </span>
      </div>
    </Autocomplete>
  )
}

function PaletteItem(props: {
  id: string
  textValue: string
  icon: ReactNode
  hint?: string
  children: ReactNode
}) {
  return (
    <MenuItem id={props.id} textValue={props.textValue} className="h-9 py-0">
      <span
        aria-hidden
        className="flex size-4 shrink-0 text-muted-foreground [&>svg]:size-4"
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.hint ? (
        <span className="max-w-2/5 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {props.hint}
        </span>
      ) : null}
    </MenuItem>
  )
}
