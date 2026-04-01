import { AccountView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"

export const Route = createFileRoute("/.auth/account/$accountView")({
  component: AccountViewRoute,
})

function AccountViewRoute() {
  const { accountView } = Route.useParams()
  return (
    <AppShell>
      <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:py-10 sm:pl-9 sm:pr-6">
        <h1 className="mb-6 bg-gradient-to-r from-teal-400 to-sky-400 bg-clip-text font-mono text-xs font-normal uppercase tracking-[0.24em] text-transparent sm:mb-8">
          user account
        </h1>
        <AccountView
          pathname={accountView}
          classNames={betterAuthShellClassNames}
        />
      </main>
    </AppShell>
  )
}
