import {
  CreateOrganizationDialog,
  OrganizationSwitcher,
} from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect } from "react"
import { authClient, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/organization/setup")({
  component: OrganizationSetupPage,
})

function OrganizationSetupPage() {
  const router = useRouter()
  const { data: session, isPending: sessionPending } = useSession()

  const { data: organizations, isPending: orgsPending } = useQuery({
    queryKey: ["organization", "list"],
    queryFn: async () => {
      const { data } = await authClient.organization.list({})
      return data ?? []
    },
    enabled: !!session,
  })

  // Single org: set it active and redirect
  useEffect(() => {
    if (!organizations || organizations.length !== 1) return
    const first = organizations[0]
    if (!first?.id) return
    authClient.organization
      .setActive({ organizationId: first.id })
      .then(() => {
        void router.invalidate()
        router.navigate({ to: "/", replace: true })
      })
      .catch(() => {})
  }, [organizations, router])

  if (sessionPending) return null
  if (!session) return <Navigate to="/sign-in" replace />
  if (session.session?.activeOrganizationId) {
    return <Navigate to="/" replace />
  }

  if (orgsPending) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="text-sm text-zinc-400">Loading…</div>
      </div>
    )
  }

  // Multiple orgs: use prebuilt OrganizationSwitcher so user can pick one
  if (organizations && organizations.length > 1) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 py-8 text-zinc-100">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% -10%, rgba(45, 212, 191, 0.14), transparent 45%), radial-gradient(circle at 90% 110%, rgba(59, 130, 246, 0.12), transparent 40%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-md text-center">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
            Get started
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-50">
            Select your organization
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Choose which organization to use for this session.
          </p>
          <div className="mt-8 flex justify-center">
            <OrganizationSwitcher
              hidePersonal
              hideCreate
              onSetActive={() => {
                void router.invalidate()
                router.navigate({ to: "/", replace: true })
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  // Still loading list or single-org redirect in progress
  if (organizations && organizations.length === 1) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="text-sm text-zinc-400">Setting up…</div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% -10%, rgba(45, 212, 191, 0.14), transparent 45%), radial-gradient(circle at 90% 110%, rgba(59, 130, 246, 0.12), transparent 40%)",
        }}
      />
      <div className="relative mx-auto max-w-md px-4 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
          Get started
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-50">
          Create your organization
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          You need an organization to continue. Create one below.
        </p>
        <div className="mt-8 flex justify-center">
          <CreateOrganizationDialog
            open={true}
            onOpenChange={(open) => {
              if (!open) {
                void router.invalidate()
                router.navigate({ to: "/", replace: true })
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
