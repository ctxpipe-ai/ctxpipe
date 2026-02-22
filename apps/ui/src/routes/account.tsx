import { AccountView } from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

type AuthMeResponse = {
  lastLoginMethod: string | null
}

export const Route = createFileRoute("/account")({
  component: AccountPage,
})

function AccountPage() {
  const backendBase =
    import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "") ?? "http://localhost:3000"

  const { data } = useQuery({
    queryKey: ["auth-me", backendBase],
    queryFn: async (): Promise<AuthMeResponse> => {
      const response = await fetch(`${backendBase}/v1/auth/me`, {
        credentials: "include",
      })
      if (!response.ok) {
        return { lastLoginMethod: null }
      }
      return (await response.json()) as AuthMeResponse
    },
  })

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-zinc-100">
      <h1 className="text-2xl font-semibold">Account</h1>
      <p className="mt-4 text-sm text-zinc-300">
        Last login method: {data?.lastLoginMethod ?? "unknown"}
      </p>
      <div className="mt-8">
        <AccountView pathname="settings" />
      </div>
    </main>
  )
}
