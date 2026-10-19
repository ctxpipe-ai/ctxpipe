import { useSyncExternalStore } from "react"

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

type UserPreferences = {
  selectedOrganizationSlug: string | null
  isSideNavExpanded: boolean | null
  sideNavWidth: number
  /** Keyed by `${userId}:${orgSlug}`. */
  orgGuides: Record<string, OrgGuidePreferences>
  /**
   * The upgrade toasts that the user dismissed on Home (CTX-894), by
   * {@link upgradeDismissKey}. A changed item has a new key, so it shows again.
   */
  dismissedUpgrades: string[]
}

/** The most dismissed upgrade keys that the browser keeps. */
const DISMISSED_UPGRADES_MAX = 100

/** The key of one state of one upgrade item. */
export function upgradeDismissKey(item: {
  orgSlug: string
  workspaceSlug: string
  key: string
  status: string
}): string {
  return [item.orgSlug, item.workspaceSlug, item.key, item.status].join("/")
}

/** Add `key` to the dismissed upgrades; the oldest keys drop out. */
export function withDismissedUpgrade(
  preferences: UserPreferences,
  key: string,
): UserPreferences {
  if (preferences.dismissedUpgrades.includes(key)) return preferences
  return {
    ...preferences,
    dismissedUpgrades: [...preferences.dismissedUpgrades, key].slice(
      -DISMISSED_UPGRADES_MAX,
    ),
  }
}

export function clampSideNavWidth(width: number): number {
  return Math.min(
    SIDE_NAV_MAX_WIDTH,
    Math.max(SIDE_NAV_MIN_WIDTH, Math.round(width)),
  )
}

function defaultPreferences(): UserPreferences {
  return {
    selectedOrganizationSlug: null,
    isSideNavExpanded: true,
    sideNavWidth: SIDE_NAV_DEFAULT_WIDTH,
    orgGuides: {},
    dismissedUpgrades: [],
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
    dismissedUpgrades: Array.isArray(parsed.dismissedUpgrades)
      ? parsed.dismissedUpgrades
          .filter((key): key is string => typeof key === "string")
          .slice(-DISMISSED_UPGRADES_MAX)
      : [],
  }
}

const SERVER_PREFERENCES = defaultPreferences()
const listeners = new Set<() => void>()
/** The last stored text and its parse, so a snapshot keeps its identity. */
let cache: { raw: string | null; value: UserPreferences } | null = null

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(USER_PREFERENCES_KEY)
  } catch {
    return cache?.raw ?? null
  }
}

/** Reads storage each time, so a change from elsewhere (a test) shows too. */
function snapshot(): UserPreferences {
  const raw = readRaw()
  if (!cache || cache.raw !== raw) {
    cache = { raw, value: parseUserPreferences(raw) }
  }
  return cache.value
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function updatePreferences(
  updater: (prev: UserPreferences) => UserPreferences,
) {
  const next = updater(snapshot())
  const raw = JSON.stringify(next)
  try {
    window.localStorage.setItem(USER_PREFERENCES_KEY, raw)
  } catch {
    // Storage can be full or blocked. Keep the value for this page.
  }
  cache = { raw, value: next }
  for (const listener of listeners) listener()
}

/**
 * One store for every hook, so all readers see an update at once. The
 * server render and hydration use the defaults; `isLoaded` is false then.
 */
export function useUserPreferences() {
  const preferences = useSyncExternalStore(
    subscribe,
    snapshot,
    () => SERVER_PREFERENCES,
  )
  const isLoaded = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
  return [preferences, updatePreferences, isLoaded] as const
}
