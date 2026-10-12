import { createFileRoute, Navigate } from "@tanstack/react-router"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { WorkspaceCreateForm } from "@/features/workspaces/WorkspaceCreateForm"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/workspaces/new")({
  component: NewWorkspaceRoute,
})

export function NewWorkspaceSessionFallback() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-6 py-16">
      <PageBodySkeleton label="Loading new workspace" />
    </main>
  )
}

export function NewWorkspacePageContent(props: { orgSlug: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-6 py-16">
      <WorkspaceCreateForm orgSlug={props.orgSlug} />
    </main>
  )
}

function NewWorkspaceRoute() {
  const { orgSlug } = Route.useParams()
  const { data: session, isPending } = useSession()

  if (isPending) return <NewWorkspaceSessionFallback />
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return <NewWorkspacePageContent orgSlug={orgSlug} />
}
