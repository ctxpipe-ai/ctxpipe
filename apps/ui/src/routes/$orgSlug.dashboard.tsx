import { createFileRoute } from "@tanstack/react-router"
import { OrgDashboardPage as OrgDashboardPageContent } from "@/features/dashboard/OrgDashboardPage"

export const Route = createFileRoute("/$orgSlug/dashboard")({
  component: OrgDashboardPage,
})

function OrgDashboardPage() {
  const { orgSlug } = Route.useParams()
  return <OrgDashboardPageContent orgSlug={orgSlug} />
}
