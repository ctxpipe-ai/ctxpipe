import { useCallback, useEffect, useState } from "react"

const USER_PREFERENCES_KEY = "ctxpipe:userPreferences"

export const SIDE_NAV_COLLAPSED_WIDTH = 44
export const SIDE_NAV_DEFAULT_WIDTH = 224
export const SIDE_NAV_MIN_WIDTH = 180
export const SIDE_NAV_MAX_WIDTH = 360

type UserPreferences = {
  selectedOrganizationSlug: string | null
  isSideNavExpanded: boolean | null
  sideNavWidth: number
}

export function clampSideNavWidth(width: number): number {
  return Math.min(
    SIDE_NAV_MAX_WIDTH,
    Math.max(SIDE_NAV_MIN_WIDTH, Math.round(width)),
  )
}

function readStoredPreferences(): UserPreferences {
  const raw = window.localStorage.getItem(USER_PREFERENCES_KEY)
  if (!raw) {
    return {
      selectedOrganizationSlug: null,
      isSideNavExpanded: true,
      sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return {
      selectedOrganizationSlug: parsed.selectedOrganizationSlug ?? null,
      isSideNavExpanded: parsed.isSideNavExpanded ?? true,
      sideNavWidth:
        typeof parsed.sideNavWidth === "number"
          ? clampSideNavWidth(parsed.sideNavWidth)
          : SIDE_NAV_DEFAULT_WIDTH,
    }
  } catch {
    return {
      selectedOrganizationSlug: null,
      isSideNavExpanded: true,
      sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
    }
  }
}

export function useUserPreferences() {
  // Keep initial SSR/CSR render identical to avoid hydration mismatches.
  const [preferences, setPreferences] = useState<UserPreferences>({
    selectedOrganizationSlug: null,
    isSideNavExpanded: true,
    sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
  })

  useEffect(() => {
    setPreferences(readStoredPreferences())
  }, [])

  const updatePreferences = useCallback(
    (updater: (prev: UserPreferences) => UserPreferences) => {
      setPreferences((prev) => {
        const next = updater(prev)

        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            USER_PREFERENCES_KEY,
            JSON.stringify(next),
          )
        }

        return next
      })
    },
    [],
  )
  return [preferences, updatePreferences] as const
}
