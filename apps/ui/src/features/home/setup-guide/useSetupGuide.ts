import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { githubSetupLinkOptions } from "@/features/connectors/queries/github-connector"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import { workspaceHydrateInFlight } from "@/features/workspaces/projection"
import {
  landingWorkspace,
  workspaceDetailOptions,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { pollWhileOk } from "@/lib/api-result"
import { authClient, useListOrganizations, useSession } from "@/lib/auth-client"
import { useOrgMemberRole } from "@/lib/org-member-role"
import { isAdminRole, sessionUser } from "@/lib/session-user"
import { useOrgGuide } from "@/lib/useOrgGuide"
import {
  type GuideRole,
  type GuideRow,
  type GuideView,
  guideRows,
  guideView,
  isGuideRecent,
} from "./guide-state"

/** When this app load started. The complete line shows on one load only. */
const APP_BOOT_AT = Date.now()

export type SetupGuide =
  | {
      status: "pending"
      /** The guide can still show, so Home holds its place with a skeleton. */
      mayShow: boolean
      /** The likely shape of the card when it loads. */
      collapsed: boolean
    }
  | {
      status: "ready"
      view: GuideView
      role: GuideRole
      rows: GuideRow[]
      landing: Workspace | null
      setCollapsed: (collapsed: boolean) => void
      dismiss: () => void
    }

/**
 * Reads every guide signal from real data. Each query refetches when Home
 * mounts, so a return to Home shows new progress. A failed signal query
 * counts as "not done"; a failed role query hides the guide.
 */
export function useSetupGuide(orgSlug: string): SetupGuide {
  const { data: session, isPending: sessionPending } = useSession()
  const user = sessionUser(session)
  const { data: organizations } = useListOrganizations()
  const organization = organizations?.find((org) => org.slug === orgSlug)
  const organizationId = organization?.id ?? ""
  const [guidePrefs, updateGuide, prefsLoaded] = useOrgGuide(orgSlug)

  const roleQuery = useOrgMemberRole(orgSlug, {
    enabled: user !== null,
    refetchOnMount: "always",
  })
  const role: GuideRole = isAdminRole(roleQuery.data?.role) ? "admin" : "member"
  const isAdmin = roleQuery.isSuccess && role === "admin"

  const membersQuery = useQuery({
    queryKey: ["organization-members", orgSlug],
    queryFn: () =>
      authClient.organization.listMembers({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      }),
    enabled: isAdmin,
    refetchOnMount: "always",
  })
  const invitationsQuery = useQuery({
    queryKey: ["organization-invitations", orgSlug, organizationId],
    queryFn: () =>
      authClient.organization.listInvitations({
        query: { organizationId },
        fetchOptions: { throw: true },
      }),
    enabled: isAdmin && organizationId !== "",
    refetchOnMount: "always",
  })
  const githubQuery = useQuery({
    ...githubSetupLinkOptions(orgSlug),
    enabled: isAdmin,
    refetchOnMount: "always",
  })
  const connectionsQuery = useQuery({
    ...orgConnectionsOptions(orgSlug),
    enabled: isAdmin,
    refetchOnMount: "always",
  })
  const listQuery = useQuery({
    ...workspaceListOptions(orgSlug),
    refetchOnMount: "always",
    // Poll while the first Workspace builds, so "Building" goes away.
    refetchInterval: (query) => {
      const data = query.state.data
      const first = data ? landingWorkspace(data) : null
      return first && workspaceHydrateInFlight(first)
        ? pollWhileOk(5000)(query)
        : false
    },
  })
  const landing = listQuery.data ? landingWorkspace(listQuery.data) : null
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, landing?.slug ?? ""),
    enabled: isAdmin && landing !== null,
    refetchOnMount: "always",
  })

  const workspaces = listQuery.data?.items ?? []
  const asked = workspaces.some((item) => item.mostRecentConversationId)
  const pending =
    sessionPending ||
    !prefsLoaded ||
    (user !== null && roleQuery.isPending) ||
    listQuery.isPending ||
    (isAdmin &&
      (membersQuery.isPending ||
        githubQuery.isPending ||
        connectionsQuery.isPending ||
        (organizationId !== "" && invitationsQuery.isPending) ||
        (landing !== null && detailQuery.isPending)))

  const rows = guideRows({
    role,
    githubLinked: githubQuery.data === "linked",
    workspaceCount: workspaces.length,
    landingBuilding: landing !== null && workspaceHydrateInFlight(landing),
    linkedRepositories: (detailQuery.data?.linkedRepositories.length ?? 0) > 0,
    asked,
    toolConnected: (connectionsQuery.data ?? []).some(
      (connection) => connection.type !== "github",
    ),
    teamInvited:
      (invitationsQuery.data ?? []).some(
        (invitation) =>
          invitation.status === "pending" || invitation.status === "accepted",
      ) || (membersQuery.data?.total ?? 0) > 1,
    explored: Boolean(guidePrefs.exploredAt),
  })
  const view: GuideView =
    pending || !user || roleQuery.isError
      ? { kind: "hidden" }
      : guideView({
          rows,
          prefs: guidePrefs,
          onboardingCompletedAt: user.onboardingCompletedAt,
          orgCreatedAt: organization?.createdAt,
          workspaceCount: workspaces.length,
          now: Date.now(),
          appBootAt: APP_BOOT_AT,
        })

  // Store when the guide first shows, so it stays for 14 days, also after
  // the first Workspace in an older organization.
  const recordStart = view.kind === "open" && !guidePrefs.startedAt
  useEffect(() => {
    if (!recordStart) return
    updateGuide((guide) =>
      guide.startedAt
        ? guide
        : { ...guide, startedAt: new Date().toISOString() },
    )
  }, [recordStart, updateGuide])

  // Store when the complete line first shows, so the next load removes it.
  const recordComplete = view.kind === "complete" && view.record
  useEffect(() => {
    if (!recordComplete) return
    updateGuide((guide) =>
      guide.completedAt
        ? guide
        : { ...guide, completedAt: new Date().toISOString() },
    )
  }, [recordComplete, updateGuide])

  if (pending) {
    return {
      status: "pending",
      mayShow:
        prefsLoaded &&
        !guidePrefs.dismissedAt &&
        (listQuery.data?.items.length === 0 ||
          isGuideRecent({
            onboardingCompletedAt: user?.onboardingCompletedAt,
            orgCreatedAt: organization?.createdAt,
            guideStartedAt: guidePrefs.startedAt,
            now: Date.now(),
          })),
      collapsed: guidePrefs.collapsed ?? asked,
    }
  }
  return {
    status: "ready",
    view,
    role,
    rows,
    landing,
    setCollapsed: (collapsed) =>
      updateGuide((guide) => ({ ...guide, collapsed })),
    dismiss: () =>
      updateGuide((guide) => ({
        ...guide,
        dismissedAt: new Date().toISOString(),
      })),
  }
}
