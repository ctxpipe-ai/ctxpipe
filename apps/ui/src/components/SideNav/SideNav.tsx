import {
  IconHome,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { Button } from "react-aria-components"
import { OverlayNavCloseButton } from "@/components/OverlayNavButton"
import { useShellLayout } from "@/components/ShellLayoutContext"
import { WorkspaceCommandPalette } from "@/features/workspaces/WorkspaceCommandPalette"
import { WorkspaceNavList } from "@/features/workspaces/WorkspaceNavList"
import { focusVisibleClassName } from "@/lib/focus-styles"
import {
  clampSideNavWidth,
  SIDE_NAV_COLLAPSED_WIDTH,
  SIDE_NAV_DEFAULT_WIDTH,
  SIDE_NAV_MAX_WIDTH,
  SIDE_NAV_MIN_WIDTH,
  useUserPreferences,
} from "@/lib/user-preferences"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"
import { prefetchOrgConnectors, prefetchOrgHome } from "./prefetch-org-pages"
import { SideNavItem } from "./SideNavItem"
import { SideNavLogo } from "./SideNavLogo"
import { SideNavOrganizationButton } from "./SideNavOrganizationButton"
import { SideNavTooltip } from "./SideNavTooltip"
import { SideNavUserButton } from "./SideNavUserButton"
import {
  parseSideNavLocation,
  type SideNavLocation,
  sideNavLocationKey,
} from "./sideNavLocation"
import {
  sideNavIconGutterClassName,
  sideNavLabelClassName,
  sideNavRevealClassName,
  sideNavRowClassName,
  sideNavTrailingSlotClassName,
} from "./sideNavStyles"

export function SideNav() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { navOpen, setNavOpen } = useShellLayout()
  const [
    { isSideNavExpanded: expanded, selectedOrganizationSlug, sideNavWidth },
    updatePreferences,
  ] = useUserPreferences()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const pathname = router.state?.location.pathname ?? ""
  const committedNav = parseSideNavLocation(pathname, selectedOrganizationSlug)
  const [nav, setNav] = useUrgentValue(
    committedNav,
    sideNavLocationKey(committedNav),
  )
  const orgSlug = nav.orgSlug
  const currentWorkspaceSlug = nav.workspaceSlug
  const currentConversationId = nav.conversationId
  const selectNav = (next: SideNavLocation) => {
    setNav(next)
  }

  useEffect(() => {
    if (pathname) setNavOpen(false)
  }, [pathname, setNavOpen])

  const handleToggle = () => {
    navRef.current?.style.removeProperty("width")
    updatePreferences((prev) => ({
      ...prev,
      isSideNavExpanded: !prev.isSideNavExpanded,
    }))
  }

  if (expanded === null) {
    return (
      <div
        className="hidden shrink-0 md:block"
        style={{ width: SIDE_NAV_COLLAPSED_WIDTH }}
      />
    )
  }

  const persistedWidth = sideNavWidth ?? SIDE_NAV_DEFAULT_WIDTH
  const railWidth = expanded ? persistedWidth : SIDE_NAV_COLLAPSED_WIDTH

  return (
    <>
      <nav
        ref={navRef}
        className={cn(
          "group/sidenav flex h-screen flex-col pt-1",
          // Width: expanded drawer on small screens; preference rail from md up.
          "w-[var(--side-nav-expanded-width)] md:w-[var(--side-nav-rail-width)]",
          // Burger overlay (< md)
          "fixed inset-y-0 left-0 z-50 bg-zinc-950 shadow-xl",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          navOpen ? "translate-x-0" : "-translate-x-full",
          // Rail (≥ md) — always on-screen, in normal flow
          "md:sticky md:top-0 md:z-20 md:translate-x-0 md:bg-transparent md:shadow-none",
          isResizing
            ? ""
            : "md:transition-[width] md:duration-200 md:ease-out motion-reduce:md:transition-none",
        )}
        style={
          {
            "--side-nav-rail-width": `${railWidth}px`,
            "--side-nav-expanded-width": `${persistedWidth}px`,
          } as CSSProperties
        }
        aria-label="Main navigation"
      >
        <div className="relative flex h-11 shrink-0 items-center">
          <div
            className={cn(
              "min-w-0 max-md:flex-1 max-md:opacity-100",
              expanded
                ? "flex-1 opacity-100"
                : [sideNavRevealClassName, "w-0 flex-none opacity-0"].join(" "),
            )}
          >
            <SideNavLogo />
          </div>
          <OverlayNavCloseButton className="mr-1.5" />
          <div className="hidden md:contents">
            <SideNavTooltip
              label={expanded ? "Collapse navigation" : "Expand navigation"}
              enabled={!expanded}
            >
              <Button
                onClick={handleToggle}
                aria-label={
                  expanded ? "Collapse navigation" : "Expand navigation"
                }
                className={
                  expanded
                    ? [
                        "mr-1.5 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-teal-900/30 hover:text-zinc-50",
                        focusVisibleClassName,
                      ].join(" ")
                    : sideNavRowClassName({ active: false })
                }
              >
                {expanded ? (
                  <IconLayoutSidebarLeftCollapse
                    className="size-4"
                    stroke={1.4}
                    aria-hidden="true"
                  />
                ) : (
                  <span className={sideNavIconGutterClassName}>
                    <IconLayoutSidebarLeftExpand
                      stroke={1.4}
                      aria-hidden="true"
                    />
                  </span>
                )}
              </Button>
            </SideNavTooltip>
          </div>
        </div>

        <ul
          className="relative mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto py-1 pb-2"
          aria-label="Primary"
        >
          <li>
            <SideNavItem
              to="/$orgSlug"
              params={{ orgSlug }}
              label="Home"
              icon={<IconHome stroke={1.4} />}
              expanded={expanded}
              active={nav.primary === "home"}
              onHoverStart={() => {
                if (orgSlug) prefetchOrgHome(queryClient, orgSlug)
              }}
              onPress={() => {
                if (orgSlug) prefetchOrgHome(queryClient, orgSlug)
                selectNav({ orgSlug, primary: "home" })
              }}
            />
          </li>
          <li>
            <SideNavTooltip label="Search" enabled={!expanded}>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label={expanded ? undefined : "Search"}
                className={sideNavRowClassName({ active: false })}
              >
                <span className={sideNavIconGutterClassName}>
                  <IconSearch stroke={1.4} />
                </span>
                <span
                  className={[
                    sideNavLabelClassName(expanded),
                    "truncate text-left",
                  ].join(" ")}
                  aria-hidden={!expanded}
                >
                  Search
                </span>
                <kbd
                  className={[
                    sideNavTrailingSlotClassName,
                    "font-mono text-xs leading-none text-zinc-500 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                    expanded
                      ? "opacity-100"
                      : "w-0 overflow-hidden opacity-0 max-md:w-auto max-md:opacity-100",
                  ].join(" ")}
                  aria-hidden={!expanded}
                >
                  ⌘K
                </kbd>
              </button>
            </SideNavTooltip>
          </li>
          <li>
            <SideNavItem
              to="/$orgSlug/connectors"
              params={{ orgSlug }}
              label="Connectors"
              icon={<IconPlug stroke={1.4} />}
              expanded={expanded}
              active={nav.primary === "connectors"}
              onHoverStart={() => {
                if (orgSlug) prefetchOrgConnectors(queryClient, orgSlug)
              }}
              onPress={() => {
                if (orgSlug) prefetchOrgConnectors(queryClient, orgSlug)
                selectNav({ orgSlug, primary: "connectors" })
              }}
            />
          </li>
          {orgSlug ? (
            <WorkspaceNavList
              orgSlug={orgSlug}
              expanded={expanded}
              currentWorkspaceSlug={currentWorkspaceSlug}
              currentConversationId={currentConversationId}
              onSelectNav={selectNav}
            />
          ) : null}
        </ul>

        <ul
          className="relative w-full shrink-0 space-y-1.5 pt-3 pb-3"
          aria-label="User actions"
        >
          <li className="w-full">
            <SideNavOrganizationButton
              expanded={expanded}
              routeOrgSlug={orgSlug}
              onSelectOrg={(nextOrgSlug) =>
                selectNav({ orgSlug: nextOrgSlug, primary: "home" })
              }
            />
          </li>
          <li className="w-full">
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

        {expanded ? (
          <button
            type="button"
            role="slider"
            aria-label="Resize navigation"
            aria-orientation="vertical"
            aria-valuemin={SIDE_NAV_MIN_WIDTH}
            aria-valuemax={SIDE_NAV_MAX_WIDTH}
            aria-valuenow={persistedWidth}
            className={[
              "absolute right-0 z-30 hidden w-3 translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 outline-none md:block",
              "top-[16px] bottom-[22px]",
              "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:translate-x-[calc(-50%+0.5px)]",
              "after:rounded-full after:bg-transparent after:transition-colors",
              "hover:after:bg-white/40 focus-visible:after:bg-white/40",
              isResizing ? "after:bg-white/55" : "",
            ].join(" ")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return
              event.preventDefault()
              const step = event.shiftKey ? 24 : 8
              const delta = event.key === "ArrowRight" ? step : -step
              updatePreferences((prev) => ({
                ...prev,
                sideNavWidth: clampSideNavWidth(prev.sideNavWidth + delta),
              }))
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              const startX = event.clientX
              const startWidth = persistedWidth
              const navEl = navRef.current
              setIsResizing(true)
              document.body.style.cursor = "col-resize"
              document.body.style.userSelect = "none"

              const move = (next: PointerEvent) => {
                const nextWidth = clampSideNavWidth(
                  startWidth + (next.clientX - startX),
                )
                if (!navEl) return
                // Drive width through the CSS vars — never inline `width`,
                // which would stick after collapse.
                navEl.style.setProperty(
                  "--side-nav-rail-width",
                  `${nextWidth}px`,
                )
                navEl.style.setProperty(
                  "--side-nav-expanded-width",
                  `${nextWidth}px`,
                )
              }
              const up = (next: PointerEvent) => {
                target.releasePointerCapture(next.pointerId)
                window.removeEventListener("pointermove", move)
                window.removeEventListener("pointerup", up)
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                navEl?.style.removeProperty("width")
                const nextWidth = clampSideNavWidth(
                  startWidth + (next.clientX - startX),
                )
                updatePreferences((prev) => ({
                  ...prev,
                  sideNavWidth: nextWidth,
                }))
                setIsResizing(false)
              }
              window.addEventListener("pointermove", move)
              window.addEventListener("pointerup", up)
            }}
          />
        ) : null}
      </nav>

      {navOpen ? (
        <button
          type="button"
          aria-label="Dismiss navigation"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
    </>
  )
}
