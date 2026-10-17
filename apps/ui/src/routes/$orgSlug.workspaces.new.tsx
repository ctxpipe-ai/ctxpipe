import {
  createFileRoute,
  Navigate,
  useNavigate,
  useSearch,
} from "@tanstack/react-router"
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton"
import {
  WorkspaceCreateForm,
  WorkspaceCreateFrame,
} from "@/features/workspaces/WorkspaceCreateForm"
import { useSession } from "@/lib/auth-client"

/**
 * `?workspace=<slug>` names the Workspace that step 2 adds sources to. It is
 * set when the Workspace is created, so step 1 does not show again for it.
 */
export function newWorkspaceSearch(search: Record<string, unknown>): {
  workspace?: string
} {
  return typeof search.workspace === "string" && search.workspace !== ""
    ? { workspace: search.workspace }
    : {}
}

export const Route = createFileRoute("/$orgSlug/workspaces/new")({
  validateSearch: newWorkspaceSearch,
  component: NewWorkspaceRoute,
})

const pageClassName = "mx-auto min-h-screen w-full max-w-2xl px-6 py-16"

/**
 * The page before the session answers. It has the same heading, steps, and
 * card as the page, with a skeleton in the card.
 */
export function NewWorkspaceSessionFallback() {
  return (
    <main className={pageClassName}>
      <WorkspaceCreateFrame step={0}>
        <div aria-busy>
          <span className="sr-only">Loading new workspace</span>
          <SkeletonText className="text-sm" boneClassName="w-3/4" />
          <Skeleton className="mt-4 block h-16 w-full" />
          <Skeleton className="mt-4 block h-10 w-full" />
          <div className="mt-3 space-y-2">
            <Skeleton className="block h-10 w-full" />
            <Skeleton className="block h-10 w-full" />
            <Skeleton className="block h-10 w-full" />
          </div>
        </div>
      </WorkspaceCreateFrame>
    </main>
  )
}

export function NewWorkspacePageContent(props: { orgSlug: string }) {
  const { orgSlug } = props
  const navigate = useNavigate()
  const { workspace } = newWorkspaceSearch(useSearch({ strict: false }))

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
      />
    </main>
  )
}

/** Waits for the session, then shows the page. Signed-out users go to sign-in. */
export function NewWorkspaceGate(props: { orgSlug: string }) {
  const { data: session, isPending } = useSession()

  if (isPending) return <NewWorkspaceSessionFallback />
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return <NewWorkspacePageContent orgSlug={props.orgSlug} />
}

function NewWorkspaceRoute() {
  const { orgSlug } = Route.useParams()
  return <NewWorkspaceGate orgSlug={orgSlug} />
}
