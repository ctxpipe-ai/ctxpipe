import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { WorkspaceCreateForm } from "@/features/workspaces/WorkspaceCreateForm"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/workspaces/new")({
  component: NewWorkspaceRoute,
})

export function NewWorkspacePageContent(props: { orgSlug: string }) {
  return (
    <AppShell>
      <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-16">
        <WorkspaceCreateForm orgSlug={props.orgSlug} />
      </main>
    </AppShell>
  )
}

function NewWorkspaceRoute() {
  const { orgSlug } = Route.useParams()
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <AppShell>
        <p className="p-8 text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return <NewWorkspacePageContent orgSlug={orgSlug} />
}
