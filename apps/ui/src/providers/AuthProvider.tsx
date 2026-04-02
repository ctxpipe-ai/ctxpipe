import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { Link, useRouter } from "@tanstack/react-router"
import type { FC } from "react"
import { authClient } from "@/lib/auth-client"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"

/**
 * better-auth-ui's SignUpForm navigates to sign-in after a successful link-based
 * sign-up (emailVerification.otp is falsy). Detect that specific transition and
 * redirect to our custom "check your email" view instead.
 */
function toEmailVerificationIfSignUp(href: string): string {
  try {
    const url = new URL(href, window.location.origin)
    if (
      url.pathname === "/.auth/sign-in" &&
      window.location.pathname === "/.auth/sign-up"
    ) {
      return "/.auth/email-verification"
    }
  } catch {
    /* invalid URL — pass through */
  }
  return href
}

export const AuthProvider: FC<React.PropsWithChildren> = ({ children }) => {
  const router = useRouter()
  const firstSegment = router.state.location.pathname
    .split("/")
    .filter(Boolean)[0]
  const orgSlug =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined

  const { data: config } = useGetAuthConfig()
  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        basePath="/.auth"
        authClient={authClient}
        emailVerification
        social={{ providers: config?.providers ?? [] }}
        navigate={(href) => {
          window.location.href = toEmailVerificationIfSignUp(href)
        }}
        replace={(href) => {
          window.location.replace(toEmailVerificationIfSignUp(href))
        }}
        persistClient={false}
        credentials={{ forgotPassword: true }}
        twoFactor={["totp"]}
        account={{ basePath: "/.auth/account" }}
        organization={
          orgSlug
            ? { slug: orgSlug, basePath: "/.auth/organization" }
            : { basePath: "/.auth/organization" }
        }
        onSessionChange={() => {
          void router.invalidate()
        }}
        Link={({ href, ...props }) => <Link to={href} {...props} />}
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  )
}
