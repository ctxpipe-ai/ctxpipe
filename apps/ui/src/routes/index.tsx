import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useListOrganizations, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const { data: session, isPending } = useSession()
  const { data: organizations } = useListOrganizations()

  if (isPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  const firstOrganization = organizations?.[0]
  if (firstOrganization) {
    return (
      <Navigate
        to={`/$orgSlug`}
        params={{ orgSlug: firstOrganization.slug }}
        replace
      />
    )
  }

  // Shouldn't get here as we auto-create a default organization for the user
  return null
}
