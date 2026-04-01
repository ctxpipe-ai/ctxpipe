import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { Link, useRouter } from "@tanstack/react-router"
import type { FC } from "react"
import { authClient } from "@/lib/auth-client"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"

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
        social={{ providers: config?.providers ?? [] }}
        navigate={(href) => {
          window.location.href = href
        }}
        replace={(href) => {
          window.location.replace(href)
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
