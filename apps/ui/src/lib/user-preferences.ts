import { useCallback, useEffect, useState } from "react"

const USER_PREFERENCES_KEY = "ctxpipe:userPreferences"

type UserPreferences = {
  selectedOrganizationSlug: string | null
  isSideNavExpanded: boolean | null
}

function readStoredPreferences(): UserPreferences {
  const raw = window.localStorage.getItem(USER_PREFERENCES_KEY)
  if (!raw) {
    return {
      selectedOrganizationSlug: null,
      isSideNavExpanded: true,
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return {
      selectedOrganizationSlug: parsed.selectedOrganizationSlug ?? null,
      isSideNavExpanded: parsed.isSideNavExpanded ?? true,
    }
  } catch {
    return {
      selectedOrganizationSlug: null,
      isSideNavExpanded: true,
    }
  }
}

export function useUserPreferences() {
  // Keep initial SSR/CSR render identical to avoid hydration mismatches.
  const [preferences, setPreferences] = useState<UserPreferences>({
    selectedOrganizationSlug: null,
    isSideNavExpanded: true,
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
