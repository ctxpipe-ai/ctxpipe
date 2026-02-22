import { AccountView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/account/$accountView")({
  component: AccountViewRoute,
})

function AccountViewRoute() {
  const { accountView } = Route.useParams()
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-zinc-100">
      <AccountView pathname={accountView} />
    </main>
  )
}
