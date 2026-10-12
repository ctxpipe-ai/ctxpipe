import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/Button"
import { HomeComposer } from "@/features/home/HomeComposer"
import {
  ASK_PROMPT,
  SetupGuideCard,
} from "@/features/home/setup-guide/SetupGuide"
import { useSetupGuide } from "@/features/home/setup-guide/useSetupGuide"
import { WorkspaceActivity } from "@/features/home/WorkspaceActivity"
import { OrgOutletError } from "@/features/org/OrgOutletError"
import {
  landingWorkspace,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"
import { useUrgentValue } from "@/lib/useUrgentValue"

export const Route = createFileRoute("/$orgSlug/")({
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
  const navigate = useNavigate()
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
  const [askSeed, setAskSeed] = useState<string | null>(null)

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
      draftSeed={askSeed}
    />
  )
  const hasWorkspace = sessionPending || listQuery.isPending || selected
  // With no Workspace, the setup guide takes the composer's place. Without
  // the guide (an established user), keep the composer and the create button.
  const body = hasWorkspace ? (
    <>
      {composer}
      {guide.status === "ready" ? (
        <SetupGuideCard
          orgSlug={orgSlug}
          guide={guide}
          onAsk={() => setAskSeed(ASK_PROMPT)}
        />
      ) : null}
      <WorkspaceActivity
        orgSlug={orgSlug}
        workspaceSlug={sessionPending ? null : (selected?.slug ?? null)}
        workspaces={workspaces}
      />
    </>
  ) : guide.status === "pending" ? null : guide.view.kind !== "hidden" ? (
    <SetupGuideCard orgSlug={orgSlug} guide={guide} />
  ) : (
    <>
      {composer}
      <Button
        variant="primary"
        onPress={() => {
          void navigate({
            to: "/$orgSlug/workspaces/new",
            params: { orgSlug },
          })
        }}
      >
        Create a workspace
      </Button>
    </>
  )

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
      <div className="mx-auto box-border w-full max-w-2xl p-8">
        <div className="space-y-10">{body}</div>
      </div>
    </div>
  )
}
