import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { OAuthConsent } from "@/features/auth/OAuthConsent"
import { authClient, useListOrganizations, useSession } from "@/lib/auth-client"
import {
  getOAuthOrganizationChangeHref,
  getOAuthRedirectUri,
} from "@/lib/auth-continuation"

function readActiveOrganizationId(session: unknown): string | null {
  if (!session || typeof session !== "object") return null
  const value = Reflect.get(session, "activeOrganizationId")
  return typeof value === "string" ? value : null
}

export const Route = createFileRoute("/.auth/consent")({
  component: ConsentPage,
})

export function ConsentPage() {
  const [isSubmitting, setIsSubmitting] = useState<"allow" | "deny" | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const { data: sessionData, isPending: sessionPending } = useSession()
  const { data: organizations, isPending: organizationsPending } =
    useListOrganizations()

  const searchParams = useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams()
    return new URLSearchParams(window.location.search)
  }, [])

  const clientId = searchParams.get("client_id")
  const requestedScope = searchParams.get("scope") ?? undefined
  const scopes = requestedScope?.split(" ").filter(Boolean) ?? []
  const activeOrganizationId = readActiveOrganizationId(sessionData?.session)
  const organization =
    organizations?.find(({ id }) => id === activeOrganizationId) ??
    (organizations?.length === 1 ? organizations[0] : null)
  const changeOrganizationHref =
    (organizations?.length ?? 0) > 1
      ? getOAuthOrganizationChangeHref(
          typeof window === "undefined" ? "" : window.location.search,
        )
      : null

  const handleConsent = async (accept: boolean) => {
    setError(null)
    setIsSubmitting(accept ? "allow" : "deny")

    const { data, error: requestError } = await authClient.oauth2.consent({
      accept,
      scope: requestedScope,
      fetchOptions: { throw: false },
    })

    if (requestError) {
      setError(requestError.message ?? "Authorisation failed")
      setIsSubmitting(null)
      return
    }

    const redirectUri = getOAuthRedirectUri(data)

    if (redirectUri) {
      window.location.href = redirectUri
      return
    }

    setError("Authorisation did not return to the requesting client")
    setIsSubmitting(null)
  }

  if (sessionPending || organizationsPending) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <section
          aria-label="Loading authorisation"
          className="space-y-6 rounded-none border border-border bg-card/80 p-6"
        >
          <div className="h-4 w-32 animate-pulse bg-muted" />
          <div className="h-8 w-64 animate-pulse bg-muted" />
          <div className="space-y-2">
            <div className="h-16 animate-pulse bg-muted" />
            <div className="h-16 animate-pulse bg-muted" />
          </div>
        </section>
      </main>
    )
  }

  return (
    <OAuthConsent
      clientId={clientId}
      scopes={scopes}
      organization={
        organization
          ? { name: organization.name, slug: organization.slug }
          : null
      }
      changeOrganizationHref={changeOrganizationHref}
      error={error}
      isSubmitting={isSubmitting}
      onAllow={() => {
        void handleConsent(true)
      }}
      onDeny={() => {
        void handleConsent(false)
      }}
    />
  )
}
