import { useCallback } from "react"
import { useSession } from "@/lib/auth-client"
import {
  type OrgGuidePreferences,
  orgGuideKey,
  useUserPreferences,
  withOrgGuide,
} from "@/lib/user-preferences"

const NO_GUIDE: OrgGuidePreferences = {}

/**
 * The setup guide and hint state of the signed-in user in `orgSlug`. An
 * update reads the stored value first, so the guide, the hints and the
 * Workspace pane do not overwrite each other's fields.
 */
export function useOrgGuide(orgSlug: string) {
  const { data: session } = useSession()
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null
  const [preferences, updatePreferences, isLoaded] = useUserPreferences()
  const key = userId ? orgGuideKey(userId, orgSlug) : null
  const guide = (key ? preferences.orgGuides[key] : undefined) ?? NO_GUIDE
  const updateGuide = useCallback(
    (update: (guide: OrgGuidePreferences) => OrgGuidePreferences) => {
      if (!key) return
      updatePreferences((prev) => withOrgGuide(prev, key, update))
    },
    [key, updatePreferences],
  )
  return [guide, updateGuide, isLoaded && key !== null] as const
}

/** Records that the user opened a Workspace pane (setup guide "Explore"). */
export function useMarkWorkspaceExplored(orgSlug: string) {
  const [, updateGuide] = useOrgGuide(orgSlug)
  return useCallback(() => {
    updateGuide((guide) =>
      guide.exploredAt
        ? guide
        : { ...guide, exploredAt: new Date().toISOString() },
    )
  }, [updateGuide])
}
