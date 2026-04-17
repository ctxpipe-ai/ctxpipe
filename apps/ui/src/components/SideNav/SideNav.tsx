import {
  IconAffiliate,
  IconChevronLeft,
  IconChevronRight,
  IconGitBranch,
  IconHome,
  IconMessageCircle,
} from "@tabler/icons-react"
import { useRouter } from "@tanstack/react-router"
import { Button } from "react-aria-components"
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
  const firstSegment = router.state.location.pathname
    .split("/")
    .filter(Boolean)[0]
  const orgSlug =
    (firstSegment && !firstSegment.startsWith(".") ? firstSegment : null) ??
    selectedOrganizationSlug

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
        expanded ? "w-52" : "w-16",
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
          <SideNavItem
            to="/$orgSlug/repositories"
            params={{ orgSlug }}
            label="Repositories"
            icon={<IconGitBranch />}
            expanded={expanded}
          />
        </li>
        <li>
          <SideNavItem
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            label="Chat"
            icon={<IconMessageCircle />}
            expanded={expanded}
          />
        </li>
        <li>
          <SideNavItem
            to="/$orgSlug/knowledge-graph"
            params={{ orgSlug }}
            label="Knowledge graph"
            icon={<IconAffiliate />}
            expanded={expanded}
          />
        </li>
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
    </nav>
  )
}
