import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { betterAuthAuthViewClassNames } from "@/features/auth/betterAuthShellClassNames"
import { getAuthContinuationProps } from "@/lib/auth-continuation"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"

export const Route = createFileRoute("/.auth/sign-in")({
  component: SignInRoutePage,
})

/** Exported for Storybook — same UI as the `/.auth/sign-in` route. */
export function SignInRoutePage() {
  const { isPending: socialPending } = useGetAuthConfig()

  const continuation =
    typeof window === "undefined"
      ? undefined
      : getAuthContinuationProps(
          window.location.pathname,
          window.location.search,
        )

  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="relative mx-auto max-w-sm">
          <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
            <img
              src="/ctx_.svg"
              alt="ctxpipe"
              className="h-16 w-16 select-none"
              draggable={false}
            />
          </div>
          {!socialPending && (
            <AuthView
              pathname="sign-in"
              redirectTo={continuation?.redirectTo ?? "/onboarding"}
              className="pt-24"
              classNames={betterAuthAuthViewClassNames}
            />
          )}
        </div>
      </div>
    </main>
  )
}
