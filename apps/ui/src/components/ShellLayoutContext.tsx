"use client"

import { useRouterState } from "@tanstack/react-router"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"

import { useSelectedOrganizationSlug } from "@/lib/selected-organization"
import { useUrgentValue } from "@/lib/useUrgentValue"

import {
  parseSideNavLocation,
  type SideNavLocation,
  sideNavLocationKey,
} from "./SideNav/sideNavLocation"

type ShellLayoutContextValue = {
  /** Overlay SideNav drawer open (burger mode). Visual layout is CSS (`max-md`). */
  navOpen: boolean
  setNavOpen: (open: boolean) => void
  toggleNav: () => void
  nav: SideNavLocation
  selectNav: (next: SideNavLocation) => void
}

const defaultNav: SideNavLocation = { orgSlug: null, primary: "other" }

const ShellLayoutContext = createContext<ShellLayoutContextValue | null>(null)

export function ShellLayoutProvider(props: { children: ReactNode }) {
  const selectedOrganizationSlug = useSelectedOrganizationSlug()
  const [navOpen, setNavOpen] = useState(false)
  // Subscribe to the committed location, so that a plain link also moves the
  // active item. `selectNav` still moves it first, in the press handler.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const committedNav = parseSideNavLocation(pathname, selectedOrganizationSlug)
  const [nav, setNav] = useUrgentValue(
    committedNav,
    sideNavLocationKey(committedNav),
  )

  const toggleNav = useCallback(() => {
    setNavOpen((open) => !open)
  }, [])

  const selectNav = useCallback(
    (next: SideNavLocation) => {
      setNav(next)
    },
    [setNav],
  )

  const value = useMemo(
    () => ({
      navOpen,
      setNavOpen,
      toggleNav,
      nav,
      selectNav,
    }),
    [nav, navOpen, selectNav, toggleNav],
  )

  return (
    <ShellLayoutContext.Provider value={value}>
      {props.children}
    </ShellLayoutContext.Provider>
  )
}

export function useShellLayout(): ShellLayoutContextValue {
  const value = useContext(ShellLayoutContext)
  if (!value) {
    return {
      navOpen: false,
      setNavOpen: () => {},
      toggleNav: () => {},
      nav: defaultNav,
      selectNav: () => {},
    }
  }
  return value
}

export function useSelectNav(): (next: SideNavLocation) => void {
  return useShellLayout().selectNav
}

export function useSideNavLocation(): SideNavLocation {
  return useShellLayout().nav
}
