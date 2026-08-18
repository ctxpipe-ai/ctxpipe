import {
  IconHome,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react"
import { useRouter } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { Button } from "react-aria-components"
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
} from "../../lib/user-preferences"
import { SideNavItem } from "./SideNavItem"
import { SideNavLogo } from "./SideNavLogo"
import { SideNavOrganizationButton } from "./SideNavOrganizationButton"
import { SideNavUserButton } from "./SideNavUserButton"
import {
  sideNavIconGutterClassName,
  sideNavLabelClassName,
  sideNavRevealClassName,
  sideNavRowClassName,
  sideNavTrailingSlotClassName,
} from "./sideNavStyles"
import { SideNavTooltip } from "./SideNavTooltip"

export function SideNav() {
  const router = useRouter()
  const [
    {
      isSideNavExpanded: expanded,
      selectedOrganizationSlug,
      sideNavWidth,
    },
    updatePreferences,
  ] = useUserPreferences()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const navRef = useRef<HTMLElement>(null)
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

  if (expanded === null) {
    return (
      <div
        className="hidden shrink-0 sm:block"
        style={{ width: SIDE_NAV_COLLAPSED_WIDTH }}
      />
    )
  }

  const persistedWidth = sideNavWidth ?? SIDE_NAV_DEFAULT_WIDTH
  const width = expanded ? persistedWidth : SIDE_NAV_COLLAPSED_WIDTH

  return (
    <nav
      ref={navRef}
      className={[
        "group/sidenav relative z-20 hidden shrink-0 flex-col pt-1 sm:sticky sm:top-0 sm:flex sm:h-screen",
        isResizing
          ? ""
          : "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      ].join(" ")}
      style={{ width }}
      aria-label="Main navigation"
    >
      {/* Fixed header height; pt-1 on nav aligns with conversation tab strip. */}
      <div className="relative flex h-11 shrink-0 items-center">
        <div
          className={[
            "min-w-0",
            expanded
              ? "flex-1 opacity-100"
              : [
                  sideNavRevealClassName,
                  "w-0 flex-none opacity-0",
                ].join(" "),
          ].join(" ")}
        >
          <SideNavLogo />
        </div>
        <SideNavTooltip
          label={expanded ? "Collapse navigation" : "Expand navigation"}
          enabled={!expanded}
        >
          <Button
            onClick={handleToggle}
            aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
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
                <IconLayoutSidebarLeftExpand stroke={1.4} aria-hidden="true" />
              </span>
            )}
          </Button>
        </SideNavTooltip>
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
            exact
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
                  expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
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
          />
        </li>
        {orgSlug ? (
          <>
            <li
              aria-hidden="true"
              className="mx-3 my-2.5 border-t border-border"
            />
            <WorkspaceNavList
              orgSlug={orgSlug}
              expanded={expanded}
              currentWorkspaceSlug={currentWorkspaceSlug}
              currentConversationId={currentConversationId}
            />
          </>
        ) : null}
      </ul>

      <ul
        className="relative w-full shrink-0 space-y-1.5 pt-3 pb-3"
        aria-label="User actions"
      >
        <li className="w-full">
          <SideNavOrganizationButton expanded={expanded} />
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
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={SIDE_NAV_MIN_WIDTH}
          aria-valuemax={SIDE_NAV_MAX_WIDTH}
          aria-valuenow={persistedWidth}
          className={[
            // Hit target straddles the nav/main seam; the line is the pane's left edge.
            "absolute right-0 z-30 w-3 translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 outline-none",
            // Inset matches conversation chrome, plus 2px each end vs the pane corners.
            "top-[16px] bottom-[22px]",
            "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:translate-x-[calc(-50%+0.5px)]",
            "after:rounded-full after:bg-transparent after:transition-colors",
            "hover:after:bg-white/40 focus-visible:after:bg-white/40",
            isResizing ? "after:bg-white/55" : "",
          ].join(" ")}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
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
            const nav = navRef.current
            setIsResizing(true)
            document.body.style.cursor = "col-resize"
            document.body.style.userSelect = "none"

            // Mutate width on the element during drag — avoids re-rendering the
            // whole nav tree (and fighting transition-[width]) on every move.
            const move = (next: PointerEvent) => {
              const nextWidth = clampSideNavWidth(
                startWidth + (next.clientX - startX),
              )
              if (nav) nav.style.width = `${nextWidth}px`
            }
            const up = (next: PointerEvent) => {
              target.releasePointerCapture(next.pointerId)
              window.removeEventListener("pointermove", move)
              window.removeEventListener("pointerup", up)
              document.body.style.cursor = ""
              document.body.style.userSelect = ""
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
  )
}
