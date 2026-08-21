import { createFileRoute, Navigate } from "@tanstack/react-router"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/.auth/organization/$organizationView")({
  component: OrgSettingsRedirect,
})

function OrgSettingsRedirect() {
  const { organizationView } = Route.useParams()
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const [preferences] = useUserPreferences()

  if (sessionPending || orgsPending) {
    return (
      <div className="flex min-h-screen items-center bg-zinc-950 px-6 py-16">
        <PageBodySkeleton
          label="Loading organisation settings"
          className="mx-auto"
        />
      </div>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const storedSlug = preferences.selectedOrganizationSlug
  const matchingOrg = storedSlug
    ? organizations?.find((org) => org.slug === storedSlug)
    : undefined
  const targetOrg = matchingOrg ?? organizations?.[0]

  if (!targetOrg) return <Navigate to="/" replace />

  return (
    <Navigate
      to="/$orgSlug/organization/$organizationView"
      params={{ orgSlug: targetOrg.slug, organizationView }}
      replace
    />
  )
}
