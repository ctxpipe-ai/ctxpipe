import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/auth/$authView")({
  component: AuthViewRoute,
})

function AuthViewRoute() {
  const { authView } = Route.useParams()
  return (
    <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
      <AuthView pathname={authView} />
    </main>
  )
}
