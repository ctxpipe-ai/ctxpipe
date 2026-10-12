import { IconFolder, IconHome, IconPlug } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import {
  Autocomplete,
  type Key,
  MenuStateContext,
  useFilter,
} from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import {
  prefetchOrgConnectors,
  prefetchOrgHome,
} from "@/components/SideNav/prefetch-org-pages"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { Dialog } from "@/components/ui/Dialog"
import {
  Menu,
  MenuItem,
  MenuSection,
  menuSectionHeaderClassName,
} from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import {
  SkeletonReveal,
  SkeletonRow,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { prefetchWorkspaceRouteData } from "./ensure-route-data"
import { fetchWorkspaces, workspaceKeys } from "./queries"

type PaletteProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open?: boolean) => void
  onSelectNav?: (next: SideNavLocation) => void
}

/**
 * Cmd+K / Ctrl+K palette: go to a workspace, Home, or Connectors.
 * React Aria Autocomplete keeps focus in the search field and moves a virtual
 * focus through the menu, so arrow keys move, Enter runs, and Escape clears
 * the search before it closes the dialog.
 */
export function WorkspaceCommandPalette(props: PaletteProps) {
  const { isOpen, onOpenChange } = props

  // One listener for the life of the palette; it reads the current state.
  const toggle = useEffectEvent(() => onOpenChange(!isOpen))
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        // Stop the key here. Autocomplete sends a copy of each key from the
        // field to the menu, and that copy would toggle the palette again.
        event.stopPropagation()
        toggle()
      }
    }
    // Capture phase: this runs before React Aria handles the key.
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

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

  const matches = (name: string, slug: string, input: string) =>
    contains(name, input) || (slug !== "" && contains(slug, input))
  const results = [
    ...(workspacesLoading
      ? []
      : workspaces.map((workspace) => ({
          id: `ws:${workspace.slug}`,
          name: workspace.displayName,
          slug: workspace.slug,
        }))),
    { id: "home", name: "Home", slug: "" },
    { id: "connectors", name: "Connectors", slug: "" },
  ].filter((item) => matches(item.name, item.slug, query))
  const resultCount = results.length
  const menuRef = useRef<HTMLDivElement>(null)
  const status = workspacesLoading
    ? "Loading workspaces"
    : resultCount === 0
      ? `No results for “${query}”`
      : `${resultCount} ${resultCount === 1 ? "result" : "results"}`

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
        matches(
          textValue,
          String(node.key).startsWith("ws:") ? String(node.key).slice(3) : "",
          input,
        )
      }
    >
      <div
        className="border-b border-white/10 p-2"
        onKeyDownCapture={(event) => {
          // Escape clears the search first. Handle it here: in the app
          // shell, after a Tab press, the key otherwise reaches the modal
          // and closes it with the text still in the field.
          if (event.key === "Escape" && query !== "") {
            event.preventDefault()
            event.stopPropagation()
            setQuery("")
            return
          }
          // React Aria clears the active item when the user deletes text.
          // Enter then runs the first match, as it does after typing.
          const first = results[0]
          if (
            event.key !== "Enter" ||
            query === "" ||
            !first ||
            menuRef.current?.querySelector("[data-focused]")
          )
            return
          event.preventDefault()
          event.stopPropagation()
          run(first.id)
        }}
      >
        <SearchField
          autoFocus
          aria-label="Search workspaces and pages"
          placeholder="Search workspaces and pages"
        />
      </div>
      <output aria-live="polite" className="sr-only">
        {status}
      </output>
      <div ref={menuRef} className="max-h-96 overflow-y-auto p-1">
        {workspacesLoading ? (
          <section aria-busy aria-label="Loading workspaces">
            <SkeletonReveal>
              <div aria-hidden className={menuSectionHeaderClassName}>
                Workspaces
              </div>
            </SkeletonReveal>
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
          {!workspacesLoading && workspaces.length > 0 ? (
            <MenuSection title="Workspaces">
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
          <MenuSection title="Pages">
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
          <kbd className="font-mono text-foreground">Esc</kbd>{" "}
          {query ? "Clear" : "Close"}
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
    <MenuItem
      id={props.id}
      textValue={props.textValue}
      className="relative h-9 py-0 hover:bg-transparent"
    >
      <HoverMovesActiveItem id={props.id} />
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

/**
 * React Aria does not move the active item on hover after a key press. Move
 * it here, so the pointer and the keyboard never show two highlights. This
 * renders inside the item, where the menu state is in context.
 */
function HoverMovesActiveItem(props: { id: string }) {
  const menuState = useContext(MenuStateContext)
  return (
    <span
      aria-hidden
      className="absolute inset-0"
      onPointerEnter={() => {
        menuState?.selectionManager.setFocused(true)
        menuState?.selectionManager.setFocusedKey(props.id)
      }}
    />
  )
}
