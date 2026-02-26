import { AccountView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { authClient, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/account")({
  component: AccountPage,
})

function AccountPage() {
  const { orgSlug } = Route.useParams()
  const { data: session, isPending: sessionPending } = useSession()
  const { data: activeOrganization, isPending: activeOrgPending } =
    authClient.useActiveOrganization()

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold">Account</h1>
        {sessionPending || activeOrgPending ? null : (
          <p className="mt-4 text-sm text-zinc-300">
            Signed in as {session?.user.email ?? session?.user.name ?? "unknown"}
            {" · "}
            Route org: {orgSlug}
            {" · "}
            Active org: {activeOrganization?.slug ?? "none"}
          </p>
        )}
        <div className="mt-8">
          <AccountView pathname="settings" />
        </div>
      </main>
    </AppShell>
  )
}
