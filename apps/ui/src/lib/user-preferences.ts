import { useCallback, useState } from "react"

const USER_PREFERENCES_KEY = "ctxpipe:userPreferences"

type UserPreferences = {
  selectedOrganizationSlug: string | null
}

function readInitialPreferences(): UserPreferences {
  if (typeof window === "undefined") {
    return {
      selectedOrganizationSlug: null,
    }
  }

  const raw = window.localStorage.getItem(USER_PREFERENCES_KEY)
  if (!raw) {
    return {
      selectedOrganizationSlug: null,
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return {
      selectedOrganizationSlug: parsed.selectedOrganizationSlug ?? null,
    }
  } catch {
    return {
      selectedOrganizationSlug: null,
    }
  }
}

export function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(() =>
    readInitialPreferences(),
  )

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
  [])

  return [preferences, updatePreferences] as const
}

