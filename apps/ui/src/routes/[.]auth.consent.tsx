import { createFileRoute, useLocation } from "@tanstack/react-router"
import { useState } from "react"

import { OAuthConsent } from "@/features/auth/OAuthConsent"
import { authClient, useListOrganizations, useSession } from "@/lib/auth-client"
import { getOAuthRedirectUri } from "@/lib/auth-continuation"

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

  // Better Auth signs the browser query string. Storybook uses a memory router.
  const routerSearch = useLocation({ select: (location) => location.searchStr })
  const searchStr =
    typeof window !== "undefined" &&
    window.location.pathname === "/.auth/consent"
      ? window.location.search
      : routerSearch
  const searchParams = new URLSearchParams(searchStr)

  const clientId = searchParams.get("client_id")
  const requestedScope = searchParams.get("scope") ?? undefined
  const scopes = requestedScope?.split(" ").filter(Boolean) ?? []
  const activeOrganizationId = readActiveOrganizationId(sessionData?.session)
  const currentOrganization =
    organizations?.find(({ id }) => id === activeOrganizationId) ??
    (organizations?.length === 1 ? organizations[0] : null)

  const handleConsent = async (
    accept: boolean,
    allowedScopes: string[] = [],
    organizationIds: string[] = [],
  ) => {
    setError(null)
    setIsSubmitting(accept ? "allow" : "deny")

    const { data, error: requestError } = await authClient.oauth2.consent({
      accept,
      // Send exactly the scopes that the page showed.
      scope: accept ? allowedScopes.join(" ") : undefined,
      fetchOptions: {
        throw: false,
        // The grant reaches exactly these orgs; the backend checks each one.
        headers:
          accept && organizationIds.length > 0
            ? { "x-ctxpipe-oauth-organization": organizationIds.join(",") }
            : undefined,
      },
    })

    if (requestError) {
      setError(requestError.message ?? "Authorization failed")
      setIsSubmitting(null)
      return
    }

    const redirectUri = getOAuthRedirectUri(data)

    if (redirectUri) {
      window.location.href = redirectUri
      return
    }

    setError("Authorization did not return to the requesting client")
    setIsSubmitting(null)
  }

  if (sessionPending || organizationsPending) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <section
          aria-label="Loading authorization"
          className="space-y-6 rounded-md border border-border bg-card/80 p-6"
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
      organizations={(organizations ?? []).map(({ id, name, slug }) => ({
        id,
        name,
        slug,
      }))}
      defaultOrganizationIds={
        currentOrganization ? [currentOrganization.id] : []
      }
      error={error}
      isSubmitting={isSubmitting}
      onAllow={(allowedScopes, organizationIds) => {
        void handleConsent(true, allowedScopes, organizationIds)
      }}
      onDeny={() => {
        void handleConsent(false)
      }}
    />
  )
}
