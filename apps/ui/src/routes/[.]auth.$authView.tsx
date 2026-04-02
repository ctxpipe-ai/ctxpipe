import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"
import { betterAuthAuthViewClassNames } from "@/features/auth/betterAuthShellClassNames"
import { getAuthContinuationProps } from "@/lib/auth-continuation"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"

export const Route = createFileRoute("/.auth/$authView")({
  component: AuthViewRoute,
})

function EmailVerificationSent() {
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
          <div className="ctx-border ctx-surface shadow-none px-6 pt-24 pb-6 text-center">
            <h2 className="text-lg font-semibold text-teal-400">
              Email verification sent
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Check your email inbox and click the verification link to
              continue.
            </p>
            <a
              href="/.auth/sign-in"
              className="mt-4 inline-block text-sm text-teal-400 hover:text-teal-300 hover:underline"
            >
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    </main>
  )
}

function AuthViewRoute() {
  const { authView } = Route.useParams()

  if (authView === "email-verification") {
    return <EmailVerificationSent />
  }

  const showBranding = authView === "sign-in" || authView === "sign-up"

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
          {showBranding ? (
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
              <img
                src="/ctx_.svg"
                alt="ctxpipe"
                className="h-16 w-16 select-none"
                draggable={false}
              />
            </div>
          ) : null}
          {!socialPending && (
            <AuthView
              pathname={authView}
              redirectTo={continuation?.redirectTo ?? "/onboarding"}
              className={showBranding ? "pt-24" : undefined}
              classNames={betterAuthAuthViewClassNames}
            />
          )}
        </div>
      </div>
    </main>
  )
}
