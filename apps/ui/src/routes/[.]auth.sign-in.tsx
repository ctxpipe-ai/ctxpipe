import { AuthView } from "@daveyplate/better-auth-ui"
import { createFileRoute } from "@tanstack/react-router"

import { AuthLogoBadge } from "@/components/Logo/Logo"
import {
  betterAuthAuthViewClassNames,
  betterAuthEmailPlaceholder,
} from "@/features/auth/betterAuthShellClassNames"
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
      : getAuthContinuationProps(window.location.origin, window.location.search)

  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="relative mx-auto max-w-sm">
          <AuthLogoBadge />
          {!socialPending && (
            <AuthView
              pathname="sign-in"
              redirectTo={continuation?.redirectTo ?? "/onboarding"}
              // A fresh verification link sent at sign-in returns here too.
              callbackURL={continuation?.redirectTo}
              className="pt-24"
              classNames={betterAuthAuthViewClassNames}
              localization={{ EMAIL_PLACEHOLDER: betterAuthEmailPlaceholder }}
            />
          )}
        </div>
      </div>
    </main>
  )
}
