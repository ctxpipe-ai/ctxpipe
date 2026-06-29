import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { Link, useRouter } from "@tanstack/react-router"
import { type ComponentProps, type FC, useEffect, useRef } from "react"
import { authClient } from "@/lib/auth-client"
import { useAuthEvlogIdentity } from "@/lib/useAuthEvlogIdentity"
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

function AuthLinkFallback({
  href,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  return <a href={href} {...props} />
}

export const AuthProvider: FC<React.PropsWithChildren> = ({ children }) => {
  useAuthEvlogIdentity()
  const router = useRouter({ warn: false })
  const organizationFetch400CountRef = useRef(0)
  const routerRef = useRef(router)

  routerRef.current = router

  const pathname =
    router?.state?.location.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "/")
  const firstSegment = pathname.split("/").filter(Boolean)[0]
  const orgSlug =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined

  const { data: config } = useGetAuthConfig()

  useEffect(() => {
    const originalFetch = window.fetch.bind(window)
    let redirectScheduled = false

    const resolveRequestUrl = (input: RequestInfo | URL) => {
      if (typeof input === "string")
        return new URL(input, window.location.origin)
      if (input instanceof URL) return input
      return new URL(input.url, window.location.origin)
    }

    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      try {
        const requestUrl = resolveRequestUrl(input)
        if (
          requestUrl.pathname ===
          "/.auth/api/v1/auth/organization/get-full-organization"
        ) {
          if (response.status === 400) {
            organizationFetch400CountRef.current += 1
          } else {
            organizationFetch400CountRef.current = 0
          }

          // Circuit-break repeated invalid-org auth state to avoid infinite query churn.
          if (
            organizationFetch400CountRef.current >= 3 &&
            !redirectScheduled &&
            !window.location.pathname.startsWith("/.auth/sign-out")
          ) {
            redirectScheduled = true
            window.location.replace("/.auth/sign-out")
          }
        }
      } catch {
        // Best-effort guard only.
      }
      return response
    }

    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        basePath="/.auth"
        authClient={authClient}
        apiKey
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
          void router?.invalidate()
        }}
        Link={
          router
            ? ({ href, ...props }) => <Link to={href} {...props} />
            : AuthLinkFallback
        }
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  )
}
