import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { organizationApiKeyLocalization } from "@/features/organization/apiKeyCopy"
import { OrganizationApiKeysCard } from "@/features/organization/OrganizationApiKeysCard"
import { OrganizationSettingsNav } from "@/features/organization/OrganizationSettingsNav"
import { organizationViewClassNames } from "@/features/organization/organizationViewTheme"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

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
      <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <PageBodySkeleton label="Loading organization settings" />
      </main>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" search={{ orgSlug: undefined }} replace />
  }

  const organization = organizations?.find((org) => org.slug === orgSlug)

  return (
    <OrganizationSettingsBody
      orgSlug={orgSlug}
      organizationView={organizationView}
      organizationId={organization?.id}
    />
  )
}

export function OrganizationSettingsBody(props: {
  orgSlug: string
  organizationView: string
  organizationId: string | undefined
}) {
  const { orgSlug, organizationView, organizationId } = props
  const isApiKeys = organizationView === "api-keys"

  return (
    <main
      className={cn(
        "mx-auto px-2 py-2 text-zinc-100 sm:px-6 sm:py-10",
        isApiKeys ? "max-w-4xl" : "max-w-3xl",
      )}
    >
      <h1 className="mb-6 font-mono text-xs font-normal uppercase tracking-[0.24em] text-teal-400 sm:mb-8">
        organization settings
      </h1>
      {/* Our nav lists every view, so Settings and Members also link to API Keys. */}
      <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
        <OrganizationSettingsNav orgSlug={orgSlug} current={organizationView} />
        {isApiKeys ? (
          organizationId ? (
            <OrganizationApiKeysCard organizationId={organizationId} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This organization could not be loaded.
            </p>
          )
        ) : (
          <OrganizationView
            hideNav
            pathname={organizationView}
            localization={organizationApiKeyLocalization}
            classNames={organizationViewClassNames}
          />
        )}
      </div>
    </main>
  )
}
