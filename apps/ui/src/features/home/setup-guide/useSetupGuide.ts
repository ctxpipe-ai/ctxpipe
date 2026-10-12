import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { githubSetupLinkOptions } from "@/features/connectors/queries/github-connector"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import {
  landingWorkspace,
  workspaceDetailOptions,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { authClient, useSession } from "@/lib/auth-client"
import { useOrgGuide } from "@/lib/useOrgGuide"
import {
  type GuideRole,
  type GuideRow,
  type GuideView,
  guideRows,
  guideView,
} from "./guide-state"

/** When this app load started. The complete line shows on one load only. */
const APP_BOOT_AT = Date.now()

const BUILDING_STATUSES = new Set(["pending", "running", "hydrating"])

export const organizationMembersKeys = {
  members: (orgSlug: string) => ["organization-members", orgSlug] as const,
  invitations: (orgSlug: string, organizationId: string) =>
    ["organization-invitations", orgSlug, organizationId] as const,
}

export type SetupGuide =
  | { status: "pending" }
  | {
      status: "ready"
      view: GuideView
      role: GuideRole
      rows: GuideRow[]
      more: GuideRow[]
      landing: Workspace | null
      setCollapsed: (collapsed: boolean) => void
      dismiss: () => void
    }

/** Owner and admin can invite and connect. `role` can list several roles. */
function isAdminRole(role: string | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "owner" || part === "admin")
}

/**
 * Reads every guide signal from real data. While a signal query is pending,
 * the guide is pending. A failed query counts as "not done".
 */
export function useSetupGuide(orgSlug: string): SetupGuide {
  const { data: session, isPending: sessionPending } = useSession()
  const user = session?.user as
    | { id: string; onboardingCompletedAt?: string | null }
    | undefined
  const [guidePrefs, updateGuide, prefsLoaded] = useOrgGuide(orgSlug)

  const membersQuery = useQuery({
    queryKey: organizationMembersKeys.members(orgSlug),
    queryFn: () =>
      authClient.organization.listMembers({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      }),
    enabled: Boolean(user),
  })
  const members = membersQuery.data?.members ?? []
  const me = members.find((member) => member.userId === user?.id)
  // A failed member list gives the member rows: they need no admin access.
  const role: GuideRole = isAdminRole(me?.role) ? "admin" : "member"
  const isAdmin = role === "admin"
  const organizationId = me?.organizationId ?? ""

  const invitationsQuery = useQuery({
    queryKey: organizationMembersKeys.invitations(orgSlug, organizationId),
    queryFn: () =>
      authClient.organization.listInvitations({
        query: { organizationId },
        fetchOptions: { throw: true },
      }),
    enabled: isAdmin && organizationId !== "",
  })
  const githubQuery = useQuery({
    ...githubSetupLinkOptions(orgSlug),
    enabled: isAdmin,
  })
  const connectionsQuery = useQuery({
    ...orgConnectionsOptions(orgSlug),
    enabled: isAdmin,
  })
  const listQuery = useQuery(workspaceListOptions(orgSlug))
  const landing = listQuery.data ? landingWorkspace(listQuery.data) : null
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, landing?.slug ?? ""),
    enabled: isAdmin && landing !== null,
  })

  const pending =
    sessionPending ||
    !prefsLoaded ||
    (Boolean(user) && membersQuery.isPending) ||
    listQuery.isPending ||
    (isAdmin &&
      (githubQuery.isPending ||
        connectionsQuery.isPending ||
        (organizationId !== "" && invitationsQuery.isPending) ||
        (landing !== null && detailQuery.isPending)))

  const workspaces = listQuery.data?.items ?? []
  const { rows, more } = guideRows({
    role,
    githubLinked: githubQuery.data === "linked",
    workspaceCount: workspaces.length,
    landingBuilding: BUILDING_STATUSES.has(landing?.hydrateStatus ?? ""),
    linkedRepositories: (detailQuery.data?.linkedRepositories.length ?? 0) > 0,
    asked: workspaces.some((item) => item.mostRecentConversationId !== null),
    toolConnected: (connectionsQuery.data ?? []).some(
      (connection) => connection.type !== "github",
    ),
    teamInvited:
      (invitationsQuery.data?.length ?? 0) > 0 ||
      (membersQuery.data?.total ?? members.length) > 1,
    explored: Boolean(guidePrefs.exploredAt),
  })
  const view: GuideView =
    pending || !user
      ? { kind: "hidden" }
      : guideView({
          rows,
          prefs: guidePrefs,
          onboardingCompletedAt: user.onboardingCompletedAt,
          now: Date.now(),
          appBootAt: APP_BOOT_AT,
        })

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

  if (pending) return { status: "pending" }
  return {
    status: "ready",
    view,
    role,
    rows,
    more,
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
