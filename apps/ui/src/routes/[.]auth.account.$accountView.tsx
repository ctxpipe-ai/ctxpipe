import { AccountView } from "@daveyplate/better-auth-ui"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { AccountSettingsNav } from "@/features/auth/AccountSettingsNav"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"
import { ConnectedAppsCard } from "@/features/auth/ConnectedAppsCard"
import { PersonalApiKeysCard } from "@/features/organization/OrganizationApiKeysCard"
import { useListOrganizations } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/.auth/account/$accountView")({
  component: AccountViewRoute,
})

function AccountViewRoute() {
  const { accountView } = Route.useParams()
  return (
    <AppShell>
      <AccountSettingsBody accountView={accountView} />
    </AppShell>
  )
}

/** Exported for Storybook — same UI as `/.auth/account/$accountView`. */
export function AccountSettingsBody(props: { accountView: string }) {
  const { accountView } = props
  const isApiKeys = accountView === "api-keys"
  const isConnectedApps = accountView === "connected-apps"
  const {
    data: organizations,
    isPending,
    isRefetching,
  } = useListOrganizations()

  // The delete dialog of an organization opens this view. After the last
  // organization is gone, the user creates a new one in onboarding.
  if (
    accountView === "organizations" &&
    !isPending &&
    !isRefetching &&
    organizations?.length === 0
  ) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <main
      className={cn(
        "mx-auto px-2 py-2 text-zinc-100 sm:py-10 sm:pl-9 sm:pr-6",
        isApiKeys || isConnectedApps ? "max-w-4xl" : "max-w-3xl",
      )}
    >
      <h1 className="mb-6 bg-linear-to-r from-teal-400 to-sky-400 bg-clip-text font-mono text-xs font-normal uppercase tracking-[0.24em] text-transparent sm:mb-8">
        user account
      </h1>
      {isApiKeys || isConnectedApps ? (
        <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
          <AccountSettingsNav current={accountView} />
          {isApiKeys ? <PersonalApiKeysCard /> : <ConnectedAppsCard />}
        </div>
      ) : (
        <AccountView
          pathname={accountView}
          localization={{
            PROVIDERS: "OAuth Providers",
            PROVIDERS_DESCRIPTION:
              "Connect your account with third-party OAuth services. GitHub App repository installation is managed in Repositories.",
            LINK: "Link OAuth",
            UNLINK: "Unlink OAuth",
          }}
          classNames={betterAuthShellClassNames}
        />
      )}
    </main>
  )
}
