import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { chatDraftKey, writeChatDraft } from "@/features/chat/chat-draft"
import { activitySearch } from "@/features/home/activity-search"
import { HomeComposer } from "@/features/home/HomeComposer"
import {
  ASK_PROMPT,
  SetupGuideCard,
  SetupGuideSkeleton,
} from "@/features/home/setup-guide/SetupGuide"
import { useSetupGuide } from "@/features/home/setup-guide/useSetupGuide"
import { WorkspaceActivity } from "@/features/home/WorkspaceActivity"
import { OrgOutletError } from "@/features/org/OrgOutletError"
import { WorkspaceUpgradeAlerts } from "@/features/workspace-upgrades/WorkspaceUpgradeAlert"
import {
  landingWorkspace,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"
import { useUrgentValue } from "@/lib/useUrgentValue"

export const Route = createFileRoute("/$orgSlug/")({
  validateSearch: activitySearch,
  errorComponent: ({ error, reset }) => (
    <OrgOutletError title="Could not load home" error={error} reset={reset} />
  ),
  component: OrgHomePage,
})

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <OrgHomePageContent orgSlug={orgSlug} />
}

/** Exported for Storybook — same dashboard as org home `/` under `/$orgSlug`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const listQuery = useQuery(workspaceListOptions(orgSlug))
  const landing = listQuery.data ? landingWorkspace(listQuery.data) : null
  const [selectedId, setSelectedId] = useUrgentValue(
    landing?.id ?? null,
    orgSlug,
  )
  const selected =
    listQuery.data?.items.find((item) => item.id === selectedId) ?? landing
  const workspaces = listQuery.data?.items ?? []
  const guide = useSetupGuide(orgSlug)
  const [composerKey, setComposerKey] = useState(0)

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  if (!sessionPending && !session) {
    return <Navigate to="/.auth/sign-in" replace />
  }

  const composer = (
    <HomeComposer
      orgSlug={orgSlug}
      workspaces={workspaces}
      selected={selected}
      onSelectWorkspace={setSelectedId}
      inputKey={composerKey}
    />
  )
  // Ask: store the prompt as the draft of the current Workspace, then mount
  // a new text box, which reads that draft and takes focus.
  const ask = selected
    ? () => {
        writeChatDraft(chatDraftKey(orgSlug, selected.id), ASK_PROMPT)
        setComposerKey((key) => key + 1)
      }
    : undefined
  const guideCard =
    guide.status === "ready" ? (
      <SetupGuideCard orgSlug={orgSlug} guide={guide} onAsk={ask} />
    ) : guide.mayShow ? (
      <SetupGuideSkeleton collapsed={guide.collapsed} />
    ) : null
  const hasWorkspace = sessionPending || listQuery.isPending || selected
  // With no Workspace, the setup guide takes the composer's place. Without
  // the guide, the user goes to the Create Workspace form.
  const guideShows =
    guide.status === "ready" ? guide.view.kind !== "hidden" : guide.mayShow
  const body = hasWorkspace ? (
    <>
      <WorkspaceUpgradeAlerts orgSlug={orgSlug} workspaces={workspaces} />
      {composer}
      {guideCard}
      <WorkspaceActivity
        orgSlug={orgSlug}
        workspaceSlug={sessionPending ? null : (selected?.slug ?? null)}
        workspaces={workspaces}
      />
    </>
  ) : guideShows ? (
    guideCard
  ) : (
    // An org with no Workspace is a new user: it goes to onboarding, where
    // it creates the first Workspace. Home is never empty (CTX-745, G2).
    <Navigate to="/$orgSlug/workspaces/new" params={{ orgSlug }} replace />
  )

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
      <div className="mx-auto box-border w-full max-w-2xl p-8">
        <div className="space-y-10">{body}</div>
      </div>
    </div>
  )
}
