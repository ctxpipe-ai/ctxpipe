import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"

export const Route = createFileRoute("/$orgSlug/organization/$organizationView")(
  {
    component: OrganizationViewRoute,
  },
)

function OrganizationViewRoute() {
  const { organizationView } = Route.useParams()
  return (
    <AppShell>
      <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <OrganizationView pathname={organizationView} />
      </main>
    </AppShell>
  )
}
