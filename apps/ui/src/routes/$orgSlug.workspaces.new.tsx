import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { SkeletonRegion } from "@/components/ui/Skeleton"
import {
  WorkspaceCreateFallback,
  WorkspaceCreateForm,
} from "@/features/workspaces/WorkspaceCreateForm"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/workspaces/new")({
  // `?workspace=<slug>` names the Workspace that step 2 adds sources to. It is
  // set when the Workspace is created, so step 1 does not show again for it.
  validateSearch: (search: Record<string, unknown>): { workspace?: string } =>
    typeof search.workspace === "string" && search.workspace !== ""
      ? { workspace: search.workspace }
      : {},
  component: NewWorkspaceRoute,
})

const pageClassName = "mx-auto min-h-screen w-full max-w-2xl px-6 py-16"

/**
 * The page before the session answers. It shows the step that the URL names,
 * with the real heading, steps, and card text, and the skeleton of the card.
 */
export function NewWorkspaceSessionFallback(props: { step?: 0 | 1 }) {
  return (
    <main className={pageClassName}>
      <WorkspaceCreateFallback step={props.step ?? 0} />
    </main>
  )
}

export function NewWorkspacePageContent(props: { orgSlug: string }) {
  const { orgSlug } = props
  const navigate = useNavigate()
  const { workspace } = Route.useSearch()

  return (
    <main className={pageClassName}>
      <WorkspaceCreateForm
        orgSlug={orgSlug}
        workspaceSlug={workspace}
        // Replace the entry: Back then leaves Add Workspace, and the URL
        // opens step 2 for this Workspace.
        onCreated={(workspaceSlug) =>
          void navigate({
            to: "/$orgSlug/workspaces/new",
            params: { orgSlug },
            search: { workspace: workspaceSlug },
            replace: true,
          })
        }
        onStartAgain={() =>
          void navigate({
            to: "/$orgSlug/workspaces/new",
            params: { orgSlug },
            search: {},
            replace: true,
          })
        }
      />
    </main>
  )
}

/** Waits for the session, then shows the page. Signed-out users go to sign-in. */
export function NewWorkspaceGate(props: { orgSlug: string }) {
  const { data: session, isPending } = useSession()
  const { workspace } = Route.useSearch()

  if (!isPending && !session) return <Navigate to="/.auth/sign-in" replace />

  // One region holds the skeleton of the fallback and the skeleton of step 1,
  // so the card does not go blank when the page replaces one with the other.
  return (
    <SkeletonRegion>
      {isPending ? (
        <NewWorkspaceSessionFallback step={workspace ? 1 : 0} />
      ) : (
        <NewWorkspacePageContent orgSlug={props.orgSlug} />
      )}
    </SkeletonRegion>
  )
}

function NewWorkspaceRoute() {
  const { orgSlug } = Route.useParams()
  return <NewWorkspaceGate orgSlug={orgSlug} />
}
