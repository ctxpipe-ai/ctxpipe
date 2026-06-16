import { createFileRoute, Navigate } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/$orgSlug/dashboard" params={{ orgSlug }} replace />
}
