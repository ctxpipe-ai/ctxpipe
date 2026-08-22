"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"

type ShellLayoutContextValue = {
  /** Overlay SideNav drawer open (burger mode). Visual layout is CSS (`max-md`). */
  navOpen: boolean
  setNavOpen: (open: boolean) => void
  toggleNav: () => void
}

const ShellLayoutContext = createContext<ShellLayoutContextValue | null>(null)

export function ShellLayoutProvider(props: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)

  const toggleNav = useCallback(() => {
    setNavOpen((open) => !open)
  }, [])

  const value = useMemo(
    () => ({
      navOpen,
      setNavOpen,
      toggleNav,
    }),
    [navOpen, toggleNav],
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
    }
  }
  return value
}
