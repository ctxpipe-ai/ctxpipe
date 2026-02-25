import { AccountView } from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { client } from "@/lib/api"
import { AppShell } from "@/components/AppShell"

export const Route = createFileRoute("/account")({
  component: AccountPage,
})

function AccountPage() {
  const { data } = useQuery({
    queryKey: ["auth-me"],
    queryFn: async () => {
      const response = await client.api.v1.auth.me.$get()
      if (!response.ok) {
        return null
      }
      return response.json()
    },
  })

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-4 text-sm text-zinc-300">
          Last login method: {data?.lastLoginMethod ?? "unknown"}
        </p>
        <div className="mt-8">
          <AccountView pathname="settings" />
        </div>
      </main>
    </AppShell>
  )
}
