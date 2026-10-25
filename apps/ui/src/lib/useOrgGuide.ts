import { useCallback } from "react"

import { useSession } from "@/lib/auth-client"
import { sessionUser } from "@/lib/session-user"
import {
  type OrgGuidePreferences,
  useUserPreferences,
} from "@/lib/user-preferences"

const NO_GUIDE: OrgGuidePreferences = {}

/** The setup guide and hint state of the signed-in user in `orgSlug`. */
export function useOrgGuide(orgSlug: string) {
  const { data: session } = useSession()
  const userId = sessionUser(session)?.id ?? null
  const [preferences, updatePreferences, isLoaded] = useUserPreferences()
  const key = userId ? `${userId}:${orgSlug}` : null
  const guide = (key ? preferences.orgGuides[key] : undefined) ?? NO_GUIDE
  const updateGuide = useCallback(
    (update: (guide: OrgGuidePreferences) => OrgGuidePreferences) => {
      if (!key) return
      updatePreferences((prev) => ({
        ...prev,
        orgGuides: {
          ...prev.orgGuides,
          [key]: update(prev.orgGuides[key] ?? {}),
        },
      }))
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
