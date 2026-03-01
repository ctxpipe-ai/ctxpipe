import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/.auth/reset-password")({
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  return (
    <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
      <AuthView pathname="reset-password" />
    </main>
  )
}
