import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { organizationViewClassNames } from "@/features/organization/organizationViewTheme"

export const Route = createFileRoute(
  "/$orgSlug/organization/$organizationView",
)({
  component: OrganizationViewRoute,
})

function OrganizationViewRoute() {
  const { organizationView } = Route.useParams()
  return (
    <AppShell>
      <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <h1 className="mb-6 font-mono text-xs font-normal uppercase tracking-[0.24em] text-teal-400 sm:mb-8">
          organisation settings
        </h1>
        <OrganizationView
          pathname={organizationView}
          classNames={organizationViewClassNames}
        />
      </main>
    </AppShell>
  )
}
