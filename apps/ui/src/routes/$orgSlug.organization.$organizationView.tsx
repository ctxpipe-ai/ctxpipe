import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { organizationApiKeyLocalization } from "@/features/organization/apiKeyCopy"
import { OrganizationApiKeysCard } from "@/features/organization/OrganizationApiKeysCard"
import { OrganizationSettingsNav } from "@/features/organization/OrganizationSettingsNav"
import { organizationViewClassNames } from "@/features/organization/organizationViewTheme"
import { useListOrganizations, useSession } from "@/lib/auth-client"

export const Route = createFileRoute(
  "/$orgSlug/organization/$organizationView",
)({
  component: OrganizationViewRoutePage,
})

/** Exported for Storybook — same UI as `/$orgSlug/organization/$organizationView`. */
export function OrganizationViewRoutePage() {
  const { data: session, isPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const { organizationView, orgSlug } = Route.useParams()

  if (isPending || orgsPending) {
    return (
      <AppShell>
        <main className="flex min-h-screen items-center justify-center px-6 text-center text-zinc-100">
          <p className="text-sm text-zinc-400">
            Loading organisation settings…
          </p>
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  const organization = organizations?.find((org) => org.slug === orgSlug)

  return (
    <AppShell>
      <OrganizationSettingsBody
        orgSlug={orgSlug}
        organizationView={organizationView}
        organizationId={organization?.id}
      />
    </AppShell>
  )
}

export function OrganizationSettingsBody(props: {
  orgSlug: string
  organizationView: string
  organizationId: string | undefined
}) {
  const { orgSlug, organizationView, organizationId } = props
  const isApiKeys = organizationView === "api-keys"

  // Own the sidebar so API Keys stays visible while AuthProvider keeps
  // organization.apiKey false (that flag also unlocks org minting in the
  // personal CreateApiKeyDialog — no per-call-site opt-out in better-auth-ui).
  return (
    <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
      <h1 className="mb-6 font-mono text-xs font-normal uppercase tracking-[0.24em] text-teal-400 sm:mb-8">
        organisation settings
      </h1>
      <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
        <OrganizationSettingsNav orgSlug={orgSlug} current={organizationView} />
        <div className="min-w-0 flex-1">
          {isApiKeys ? (
            organizationId ? (
              <OrganizationApiKeysCard organizationId={organizationId} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This organisation could not be loaded.
              </p>
            )
          ) : (
            <OrganizationView
              pathname={organizationView}
              hideNav
              localization={organizationApiKeyLocalization}
              classNames={organizationViewClassNames}
            />
          )}
        </div>
      </div>
    </main>
  )
}
