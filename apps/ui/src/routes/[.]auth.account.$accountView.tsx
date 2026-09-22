import { AccountView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { AccountSettingsNav } from "@/features/auth/AccountSettingsNav"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"
import { PersonalApiKeysCard } from "@/features/organization/OrganizationApiKeysCard"
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

  return (
    <main
      className={cn(
        "mx-auto px-2 py-2 text-zinc-100 sm:py-10 sm:pl-9 sm:pr-6",
        isApiKeys ? "max-w-4xl" : "max-w-3xl",
      )}
    >
      <h1 className="mb-6 bg-linear-to-r from-teal-400 to-sky-400 bg-clip-text font-mono text-xs font-normal uppercase tracking-[0.24em] text-transparent sm:mb-8">
        user account
      </h1>
      {isApiKeys ? (
        <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
          <AccountSettingsNav current="api-keys" />
          <PersonalApiKeysCard />
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
