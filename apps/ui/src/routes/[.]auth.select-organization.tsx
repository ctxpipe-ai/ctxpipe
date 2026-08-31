import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { OAuthOrganizationSelector } from "@/features/auth/OAuthOrganizationSelector"
import { authClient, useListOrganizations } from "@/lib/auth-client"
import { getOAuthRedirectUri } from "@/lib/auth-continuation"

export const Route = createFileRoute("/.auth/select-organization")({
  component: OAuthOrganizationSelectionRoutePage,
})

export function OAuthOrganizationSelectionRoutePage() {
  const { data: organizations, isPending } = useListOrganizations()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const continueAuthorization = async (organizationId: string) => {
    setError(null)
    setIsSubmitting(true)
    try {
      await authClient.organization.setActive({
        organizationId,
        fetchOptions: { throw: true },
      })

      const { data, error: continueError } = await authClient.oauth2.continue({
        postLogin: true,
        fetchOptions: { throw: false },
      })
      if (continueError) {
        throw new Error(continueError.message ?? "Authorisation failed")
      }

      const redirectUri = getOAuthRedirectUri(data)
      if (!redirectUri) {
        throw new Error("Authorisation did not return a redirect URI")
      }
      window.location.href = redirectUri
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not select this organisation",
      )
      setIsSubmitting(false)
    }
  }

  if (isPending) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <section
          aria-label="Loading organisations"
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
    <OAuthOrganizationSelector
      organizations={(organizations ?? []).map(({ id, name, slug }) => ({
        id,
        name,
        slug,
      }))}
      error={error}
      isSubmitting={isSubmitting}
      onContinue={(organizationId) => {
        void continueAuthorization(organizationId)
      }}
    />
  )
}
