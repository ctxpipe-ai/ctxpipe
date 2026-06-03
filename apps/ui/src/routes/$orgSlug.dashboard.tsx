import { createFileRoute } from "@tanstack/react-router"
import { OrgHomePageContent } from "./$orgSlug.index"

export const Route = createFileRoute("/$orgSlug/dashboard")({
  component: OrgDashboardPage,
})

function OrgDashboardPage() {
  const { orgSlug } = Route.useParams()
  return <OrgHomePageContent orgSlug={orgSlug} />
}
