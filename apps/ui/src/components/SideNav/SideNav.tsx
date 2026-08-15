import {
  IconChevronLeft,
  IconChevronRight,
  IconHome,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react"
import { useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "react-aria-components"
import { WorkspaceCommandPalette } from "@/features/workspaces/WorkspaceCommandPalette"
import { WorkspaceNavList } from "@/features/workspaces/WorkspaceNavList"
import { useUserPreferences } from "../../lib/user-preferences"
import { SideNavItem } from "./SideNavItem"
import { SideNavLogo } from "./SideNavLogo"
import { SideNavOrganizationButton } from "./SideNavOrganizationButton"
import { SideNavUserButton } from "./SideNavUserButton"

export function SideNav() {
  const router = useRouter()
  const [
    { isSideNavExpanded: expanded, selectedOrganizationSlug },
    updatePreferences,
  ] = useUserPreferences()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pathname = router.state?.location.pathname ?? ""
  const segments = pathname.split("/").filter(Boolean)
  const firstSegment = segments[0]
  const orgSlug =
    (!firstSegment?.startsWith(".") ? firstSegment : null) ??
    selectedOrganizationSlug
  const currentWorkspaceSlug = segments[1] === "ws" ? segments[2] : undefined
  const currentConversationId =
    segments[1] === "ws" && segments[3] ? segments[3] : undefined

  const handleToggle = () => {
    updatePreferences((prev) => ({
      ...prev,
      isSideNavExpanded: !prev.isSideNavExpanded,
    }))
  }

  if (expanded === null) return <div className="w-16" />

  return (
    <nav
      className={[
        "group/sidenav relative z-20 hidden shrink-0 flex-col overflow-visible transition-[width] duration-200 ease-out motion-reduce:transition-none sm:sticky sm:top-0 sm:flex sm:h-screen",
        expanded ? "w-56" : "w-16",
      ].join(" ")}
      aria-label="Main navigation"
    >
      <SideNavLogo />

      <Button
        onClick={handleToggle}
        aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
        className={[
          "absolute right-[-18.5px] top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
          "opacity-0 transition-opacity duration-200 group-hover/sidenav:opacity-100",
          "pointer-events-none group-hover/sidenav:pointer-events-auto",
        ].join(" ")}
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-800/90 bg-zinc-900/95 text-zinc-400 shadow-lg shadow-black/30 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100">
          {expanded ? (
            <IconChevronLeft
              className="h-4 w-4 mr-[1.5px]"
              aria-hidden="true"
            />
          ) : (
            <IconChevronRight
              className="h-4 w-4 ml-[0.5px]"
              aria-hidden="true"
            />
          )}
        </span>
      </Button>

      <ul className="relative mt-2 space-y-1" aria-label="Primary">
        <li>
          <SideNavItem
            to="/$orgSlug"
            params={{ orgSlug }}
            label="Home"
            icon={<IconHome />}
            expanded={expanded}
            exact
          />
        </li>
        <li>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={expanded ? undefined : "Search"}
            className={[
              "group relative flex h-10 w-full items-center text-sm font-medium transition-colors",
              "hover:bg-teal-900/30 hover:text-zinc-50 text-zinc-300",
            ].join(" ")}
          >
            <span className="flex h-5 *:h-full *:stroke-[1.4] px-5 shrink-0 items-center justify-center text-zinc-400 group-hover:text-zinc-200">
              <IconSearch />
            </span>
            <span
              className={[
                "whitespace-nowrap transition-all duration-200",
                expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
              ].join(" ")}
            >
              Search
            </span>
            {expanded ? (
              <kbd className="ml-auto mr-3 font-mono text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            ) : null}
          </button>
        </li>
        <li>
          <SideNavItem
            to="/$orgSlug/connectors"
            params={{ orgSlug }}
            label="Connectors"
            icon={<IconPlug />}
            expanded={expanded}
          />
        </li>
        {orgSlug ? (
          <WorkspaceNavList
            orgSlug={orgSlug}
            expanded={expanded}
            currentWorkspaceSlug={currentWorkspaceSlug}
            currentConversationId={currentConversationId}
          />
        ) : null}
      </ul>

      <div className="flex-1" />

      <ul className="relative py-3" aria-label="User actions">
        <li>
          <SideNavOrganizationButton expanded={expanded} />
        </li>
        <li>
          <SideNavUserButton expanded={expanded} />
        </li>
      </ul>
      {orgSlug ? (
        <WorkspaceCommandPalette
          orgSlug={orgSlug}
          isOpen={paletteOpen}
          onOpenChange={(open) => setPaletteOpen(Boolean(open))}
        />
      ) : null}
    </nav>
  )
}
