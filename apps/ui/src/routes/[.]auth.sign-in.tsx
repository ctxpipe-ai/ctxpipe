import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { getAuthContinuationProps } from "@/lib/auth-continuation"

export const Route = createFileRoute("/.auth/sign-in")({
  component: SignInPage,
})

function SignInPage() {
  const continuation =
    typeof window === "undefined"
      ? undefined
      : getAuthContinuationProps(window.location.pathname, window.location.search)

  return (
    <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
      <AuthView pathname="sign-in" redirectTo={continuation?.redirectTo} />
    </main>
  )
}
