import { Link, useRouter } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack"
import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack"
import { authClient } from "@/lib/auth-client"
import type { FC } from "react"

export const AuthProvider: FC<React.PropsWithChildren> = ({ children }) => {
  const router = useRouter()
  const firstSegment = router.state.location.pathname
    .split("/")
    .filter(Boolean)[0]
  const orgSlug =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined

  const { data: config } = useQuery({
    queryKey: ["social-providers"],
    queryFn: () => fetch("/.auth/api/config").then((res) => res.json()),
  })
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
