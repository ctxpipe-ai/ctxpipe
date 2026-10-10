import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { Button } from "@/components/ui/Button"
import { HomeComposer } from "@/features/home/HomeComposer"
import {
  WorkspaceActivity,
  WorkspaceActivityLoading,
} from "@/features/home/WorkspaceActivity"
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

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
      <div className="mx-auto box-border w-full max-w-2xl p-8">
        <div className="space-y-10">
          <HomeComposer
            orgSlug={orgSlug}
            workspaces={workspaces}
            selected={selected}
            onSelectWorkspace={setSelectedId}
          />
          {sessionPending || listQuery.isPending ? (
            <WorkspaceActivityLoading />
          ) : selected ? (
            <WorkspaceActivity
              orgSlug={orgSlug}
              workspaceSlug={selected.slug}
            />
          ) : (
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
          )}
        </div>
      </div>
    </div>
  )
}
