import { useCallback, useEffect, useState } from "react"

const USER_PREFERENCES_KEY = "ctxpipe:userPreferences"

export const SIDE_NAV_COLLAPSED_WIDTH = 44
export const SIDE_NAV_DEFAULT_WIDTH = 224
export const SIDE_NAV_MIN_WIDTH = 180
export const SIDE_NAV_MAX_WIDTH = 360

/** Setup guide and hint state of one user in one organization (CTX-552). */
export type OrgGuidePreferences = {
  collapsed?: boolean
  dismissedAt?: string
  completedAt?: string
  exploredAt?: string
  hintsSeen?: string[]
}

export type UserPreferences = {
  selectedOrganizationSlug: string | null
  isSideNavExpanded: boolean | null
  sideNavWidth: number
  /** Keyed by `orgGuideKey(userId, orgSlug)`. */
  orgGuides: Record<string, OrgGuidePreferences>
}

export function clampSideNavWidth(width: number): number {
  return Math.min(
    SIDE_NAV_MAX_WIDTH,
    Math.max(SIDE_NAV_MIN_WIDTH, Math.round(width)),
  )
}

export function orgGuideKey(userId: string, orgSlug: string): string {
  return `${userId}:${orgSlug}`
}

/** Replace the guide state of one user and organization. */
export function withOrgGuide(
  preferences: UserPreferences,
  key: string,
  update: (guide: OrgGuidePreferences) => OrgGuidePreferences,
): UserPreferences {
  return {
    ...preferences,
    orgGuides: {
      ...preferences.orgGuides,
      [key]: update(preferences.orgGuides[key] ?? {}),
    },
  }
}

function defaultPreferences(): UserPreferences {
  return {
    selectedOrganizationSlug: null,
    isSideNavExpanded: true,
    sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
    orgGuides: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseDate(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined
}

/** Keep only the known fields with the correct type; drop the rest. */
function parseOrgGuide(value: unknown): OrgGuidePreferences | null {
  if (!isRecord(value)) return null
  const guide: OrgGuidePreferences = {}
  if (typeof value.collapsed === "boolean") guide.collapsed = value.collapsed
  const dismissedAt = parseDate(value.dismissedAt)
  if (dismissedAt) guide.dismissedAt = dismissedAt
  const completedAt = parseDate(value.completedAt)
  if (completedAt) guide.completedAt = completedAt
  const exploredAt = parseDate(value.exploredAt)
  if (exploredAt) guide.exploredAt = exploredAt
  if (Array.isArray(value.hintsSeen)) {
    guide.hintsSeen = value.hintsSeen.filter(
      (id): id is string => typeof id === "string",
    )
  }
  return guide
}

/** Parse the stored value. A missing or malformed value gives the defaults. */
export function parseUserPreferences(raw: string | null): UserPreferences {
  if (!raw) return defaultPreferences()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultPreferences()
  }
  if (!isRecord(parsed)) return defaultPreferences()
  const orgGuides: Record<string, OrgGuidePreferences> = {}
  if (isRecord(parsed.orgGuides)) {
    for (const [key, value] of Object.entries(parsed.orgGuides)) {
      const guide = parseOrgGuide(value)
      if (guide) orgGuides[key] = guide
    }
  }
  return {
    selectedOrganizationSlug:
      typeof parsed.selectedOrganizationSlug === "string"
        ? parsed.selectedOrganizationSlug
        : null,
    isSideNavExpanded:
      typeof parsed.isSideNavExpanded === "boolean"
        ? parsed.isSideNavExpanded
        : true,
    sideNavWidth:
      typeof parsed.sideNavWidth === "number"
        ? clampSideNavWidth(parsed.sideNavWidth)
        : SIDE_NAV_DEFAULT_WIDTH,
    orgGuides,
  }
}

function readStoredPreferences(): UserPreferences {
  try {
    return parseUserPreferences(
      window.localStorage.getItem(USER_PREFERENCES_KEY),
    )
  } catch {
    return defaultPreferences()
  }
}

/**
 * `isLoaded` is false on the first render, which uses the defaults so that
 * the server and client renders match. Each hook has its own state, so an
 * update reads the stored value first: two hooks do not overwrite the
 * fields of each other.
 */
export function useUserPreferences() {
  const [preferences, setPreferences] =
    useState<UserPreferences>(defaultPreferences)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    setPreferences(readStoredPreferences())
    setIsLoaded(true)
  }, [])

  const updatePreferences = useCallback(
    (updater: (prev: UserPreferences) => UserPreferences) => {
      if (typeof window === "undefined") {
        setPreferences(updater)
        return
      }
      const next = updater(readStoredPreferences())
      try {
        window.localStorage.setItem(USER_PREFERENCES_KEY, JSON.stringify(next))
      } catch {
        // Storage can be full or blocked. Keep the value for this page.
      }
      setPreferences(next)
    },
    [],
  )
  return [preferences, updatePreferences, isLoaded] as const
}
