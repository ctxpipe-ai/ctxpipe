import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const { data: session, isPending } = useSession()
  const { data: organizations } = useListOrganizations()
  const [preferences] = useUserPreferences()

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const defaultFallbackOrg = organizations?.[0]
  let targetOrganization = defaultFallbackOrg

  const hasMultipleOrgs = organizations && organizations.length > 1
  if (hasMultipleOrgs) {
    const storedSlug = preferences.selectedOrganizationSlug
    const matchingOrg = storedSlug
      ? organizations.find((org) => org.slug === storedSlug)
      : undefined
    targetOrganization = matchingOrg ?? defaultFallbackOrg
  }

  if (targetOrganization) {
    return (
      <Navigate
        to={`/$orgSlug`}
        params={{ orgSlug: targetOrganization.slug }}
        replace
      />
    )
  }

  // Shouldn't get here as we auto-create a default organization for the user
  return null
}
