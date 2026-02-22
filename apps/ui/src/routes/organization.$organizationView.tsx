import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/organization/$organizationView")({
  component: OrganizationViewRoute,
})

function OrganizationViewRoute() {
  const { organizationView } = Route.useParams()
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-zinc-100">
      <OrganizationView pathname={organizationView} />
    </main>
  )
}
