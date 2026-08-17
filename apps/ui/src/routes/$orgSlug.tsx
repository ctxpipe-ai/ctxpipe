import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router"
import { workspaceListOptions } from "@/features/workspaces/queries"
import { fetchSsrOrganizations, fetchSsrSession } from "@/lib/auth-ssr"

export const Route = createFileRoute("/$orgSlug")({
  beforeLoad: async ({ params, context }) => {
    const session = await fetchSsrSession()
    if (!session) {
      throw redirect({ to: "/.auth/sign-in" })
    }

    const user = session.user
    if (!user.onboardingCompletedAt) {
      throw redirect({
        to: "/onboarding",
        search: { orgSlug: undefined },
      })
    }

    const organizations = await fetchSsrOrganizations()
    if (organizations.length === 0) {
      throw redirect({
        to: "/onboarding",
        search: { orgSlug: undefined },
      })
    }

    const isMember = organizations.some((org) => org.slug === params.orgSlug)
    if (!isMember) {
      return {
        session,
        organizations,
        orgAccessDenied: true as const,
      }
    }

    await context.queryClient.ensureQueryData(
      workspaceListOptions(params.orgSlug),
    )

    return {
      session,
      organizations,
      orgAccessDenied: false as const,
    }
  },
  component: OrgScopedLayout,
})

function OrgScopedLayout() {
  const { orgSlug } = Route.useParams()
  const { orgAccessDenied } = Route.useRouteContext()

  if (orgAccessDenied) {
    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-lg px-6 py-16">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Access
          </p>
          <h1 className="mt-3 text-xl font-medium tracking-tight text-foreground">
            You do not have access to this organisation
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The URL may be wrong, or you may have been removed from{" "}
            <span className="font-mono text-foreground">{orgSlug}</span>. Check
            the address or open a workspace you belong to.
          </p>
          <p className="mt-6">
            <Link
              to="/"
              search={{
                error: undefined,
                error_description: undefined,
                pendingAccountClaim: undefined,
              }}
              className="text-sm text-teal-400 no-underline hover:text-teal-300 hover:underline"
            >
              Go to home
            </Link>
          </p>
        </div>
      </main>
    )
  }

  return <Outlet />
}
