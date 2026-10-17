import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
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
      <OrganizationSettingsShell orgSlug={orgSlug} current={organizationView}>
        <PageBodySkeleton label="Loading organization settings" />
      </OrganizationSettingsShell>
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
    <OrganizationSettingsBody
      orgSlug={orgSlug}
      organizationView={organizationView}
      organizationId={organization?.id}
    />
  )
}

/**
 * One frame for every sub-page and for the loading state. The width, the
 * title, and the nav never change, so only the content below moves.
 */
/** Exported for Storybook, to show the loading state in the same frame. */
export function OrganizationSettingsShell(props: {
  orgSlug: string
  current: string
  children: ReactNode
}) {
  return (
    <main className="mx-auto max-w-4xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
      <h1 className="mb-6 font-mono text-xs font-normal uppercase tracking-[0.24em] text-teal-400 sm:mb-8">
        organization settings
      </h1>
      {/* Our nav lists every view, so Settings and Members also link to API Keys. */}
      <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
        <OrganizationSettingsNav
          orgSlug={props.orgSlug}
          current={props.current}
        />
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </main>
  )
}

export function OrganizationSettingsBody(props: {
  orgSlug: string
  organizationView: string
  organizationId: string | undefined
}) {
  const { orgSlug, organizationView, organizationId } = props

  return (
    <OrganizationSettingsShell orgSlug={orgSlug} current={organizationView}>
      {organizationView === "api-keys" ? (
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
    </OrganizationSettingsShell>
  )
}
