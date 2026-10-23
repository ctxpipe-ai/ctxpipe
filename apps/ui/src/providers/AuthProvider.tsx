import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { Link, useRouter } from "@tanstack/react-router"
import { type ComponentProps, type FC, useEffect, useRef } from "react"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import { orgGateKeys } from "@/lib/org-gate"
import { useAuthEvlogIdentity } from "@/lib/useAuthEvlogIdentity"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"
import type { RouterContext } from "@/router"

/**
 * better-auth-ui's SignUpForm navigates to sign-in after a successful link-based
 * sign-up (emailVerification.otp is falsy). Detect that specific transition and
 * redirect to our custom "check your email" view instead, keeping the query
 * (redirectTo) so its sign-in link returns to the same destination.
 */
function toEmailVerificationIfSignUp(href: string): string {
  try {
    const url = new URL(href, window.location.origin)
    if (
      url.pathname === "/.auth/sign-in" &&
      window.location.pathname === "/.auth/sign-up"
    ) {
      return `/.auth/email-verification${url.search}`
    }
  } catch {
    /* invalid URL — pass through */
  }
  return href
}

// Signing in unverified sends a fresh link (sendOnSignIn), so this is a notice.
const emailNotVerifiedMessage =
  "Verify your email to sign in. We sent a new link to your inbox."

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

  const pathname =
    router?.state?.location.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "/")
  const pathSegments = pathname.split("/").filter(Boolean)
  const firstSegment = pathSegments[0]
  const orgSlug =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined
  const isOrganizationSettings = pathSegments[1] === "organization"

  const { data: config } = useGetAuthConfig()

  // An expired or invalid verification link sends them to its callback with
  // ?error=…, on whichever page that was. Say so once, wherever they land.
  // (A link that was already used just redirects, with no error.)
  useEffect(() => {
    const url = new URL(window.location.href)
    const error = url.searchParams.get("error")
    if (
      error !== "TOKEN_EXPIRED" &&
      error !== "INVALID_TOKEN" &&
      error !== "USER_NOT_FOUND"
    ) {
      return
    }
    // The Toaster in __root subscribes in its own effect, which runs after
    // this one; a toast sent before then is dropped.
    window.setTimeout(() =>
      toast.error(
        "That verification link has expired or is not valid. Sign in and we will send a new one.",
      ),
    )
    url.searchParams.delete("error")
    window.history.replaceState(window.history.state, "", url)
  }, [])

  useEffect(() => {
    const originalFetch = window.fetch.bind(window)
    let redirectScheduled = false

    const resolveRequestUrl = (input: RequestInfo | URL) => {
      if (typeof input === "string")
        return new URL(input, window.location.origin)
      if (input instanceof URL) return input
      return new URL(input.url, window.location.origin)
    }

    // Keep fetch's static members (Bun's types add `preconnect`).
    window.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
      },
      window.fetch,
    )

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
        localization={{ EMAIL_NOT_VERIFIED: emailNotVerifiedMessage }}
        // better-auth-ui sends every sign-in failure as an error toast.
        toast={({ variant = "default", message }) => {
          if (message === emailNotVerifiedMessage) toast.info(message)
          else if (variant === "default") toast(message)
          else toast[variant](message)
        }}
        twoFactor={["totp"]}
        account={{ basePath: "/.auth/account" }}
        // Keep the library's API-key navigation on organization settings while
        // excluding its organization selector from personal account settings.
        // Org key minting itself uses the configId-scoped custom card.
        organization={
          orgSlug
            ? {
                slug: orgSlug,
                basePath: "/.auth/organization",
                apiKey: isOrganizationSettings,
              }
            : {
                basePath: "/.auth/organization",
                apiKey: isOrganizationSettings,
              }
        }
        onSessionChange={() => {
          const queryClient = (
            router?.options.context as RouterContext | undefined
          )?.queryClient
          void queryClient?.invalidateQueries({ queryKey: orgGateKeys.all })
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
