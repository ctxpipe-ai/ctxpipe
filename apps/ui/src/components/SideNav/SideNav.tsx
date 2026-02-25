import { IconChevronLeft, IconChevronRight, IconCode, IconHome, IconSettings, IconUserCircle } from "@tabler/icons-react"
import { collapsedWidthClass, expandedWidthClass } from "./constants"
import { SideNavItem } from "./SideNavItem"
import { SideNavLogo } from "./SideNavLogo"
import { SideNavOrgSwitcher } from "./SideNavOrgSwitcher"
import { SideNavUserButton } from "./SideNavUserButton"

type SideNavProps = {
  expanded: boolean
  onToggle: () => void
}

export function SideNav({ expanded, onToggle }: SideNavProps) {
  return (
    <nav
      className={[
        "fixed left-0 top-0 z-20 hidden h-dvh flex-col overflow-hidden border-r border-zinc-800 bg-zinc-950/85 px-3 py-3 shadow-[8px_0_30px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:flex",
        expanded ? expandedWidthClass : collapsedWidthClass,
      ].join(" ")}
      aria-label="Main navigation"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(45,212,191,0.12),transparent_45%)]"
      />

      <div className="relative flex items-center justify-between">
        <SideNavLogo expanded={expanded} />
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800/80 bg-zinc-900/80 text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {expanded ? (
            <IconChevronLeft className="h-5 w-5" aria-hidden="true" />
          ) : (
            <IconChevronRight className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </div>

      <ul className="relative mt-5 space-y-1" aria-label="Primary">
        {expanded && (
          <li className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Workspace
          </li>
        )}
        <li>
          <SideNavItem
            to="/"
            label="Home"
            icon={<IconHome className="h-5 w-5" aria-hidden="true" />}
            expanded={expanded}
            exact
          />
        </li>
        <li>
          <SideNavItem
            to="/repositories"
            label="Repositories"
            icon={<IconCode className="h-5 w-5" aria-hidden="true" />}
            expanded={expanded}
            exact
          />
        </li>
      </ul>

      <div className="flex-1" />

      <ul className="relative space-y-1 border-t border-zinc-800/80 pt-3" aria-label="User actions">
        {expanded && (
          <li className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Preferences
          </li>
        )}
        <li>
          <SideNavItem
            to="/account/$accountView"
            params={{ accountView: "settings" }}
            label="Settings"
            icon={<IconSettings className="h-5 w-5" aria-hidden="true" />}
            expanded={expanded}
          />
        </li>
        <li>
          <SideNavItem
            to="/account"
            label="Account"
            icon={<IconUserCircle className="h-5 w-5" aria-hidden="true" />}
            expanded={expanded}
            exact
          />
        </li>
        <li>
          <SideNavOrgSwitcher expanded={expanded} />
        </li>
        <li>
          <SideNavUserButton expanded={expanded} />
        </li>
      </ul>
    </nav>
  )
}
