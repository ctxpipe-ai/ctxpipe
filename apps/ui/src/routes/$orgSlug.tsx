import type { QueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { workspaceListOptions } from "@/features/workspaces/queries"
import { orgGateOptions, peekOrgGate } from "@/lib/org-gate"

export const Route = createFileRoute("/$orgSlug")({
  shouldReload: ({ cause }) => cause === "enter",
  beforeLoad: ({ cause, params, context }) => {
    if (cause === "stay" || cause === "preload") {
      const cached = peekOrgGate(context.queryClient, params.orgSlug)
      if (cached) return cached
    }
    return resolveOrgGate(context.queryClient, params.orgSlug)
  },
  component: OrgScopedLayout,
})

async function resolveOrgGate(queryClient: QueryClient, orgSlug: string) {
  const gate = await queryClient.ensureQueryData(orgGateOptions(orgSlug))
  if (!gate.session) {
    throw redirect({ to: "/.auth/sign-in" })
  }

  const user = gate.session.user
  if (!user.onboardingCompletedAt) {
    throw redirect({
      to: "/onboarding",
      search: { orgSlug: undefined },
    })
  }

  if (gate.organizations.length === 0) {
    throw redirect({
      to: "/onboarding",
      search: { orgSlug: undefined },
    })
  }

  if (gate.orgAccessDenied) return gate

  await queryClient.ensureQueryData(workspaceListOptions(orgSlug))
  return gate
}

function OrgScopedLayout() {
  const { orgSlug } = Route.useParams()
  const { orgAccessDenied } = Route.useRouteContext()
  const setupMatch = useMatch({
    from: "/$orgSlug/setup",
    shouldThrow: false,
  })

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

  if (setupMatch) return <Outlet />

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
