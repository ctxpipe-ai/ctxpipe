import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"

export type OAuthConsentOrganization = {
  name: string
  slug: string
}

export function OAuthConsent({
  clientId,
  scopes,
  organization,
  changeOrganizationHref = null,
  error = null,
  isSubmitting = null,
  onAllow,
  onDeny,
}: {
  clientId: string | null
  scopes: string[]
  organization: OAuthConsentOrganization | null
  changeOrganizationHref?: string | null
  error?: string | null
  isSubmitting?: "allow" | "deny" | null
  onAllow: () => void
  onDeny: () => void
}) {
  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-foreground">
      <section className="space-y-6 rounded-none border border-border bg-card/80 p-6">
        <div className="space-y-2">
          <p className="ctx-label">OAuth connection</p>
          <h1 className="text-xl font-medium">Authorise client</h1>
          <p className="text-sm text-muted-foreground">
            The client below is requesting access to ctx| data from this
            organisation. The choice is bound to this connection and will not
            change when you switch organisations later.
          </p>
        </div>

        {organization ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Organisation</p>
            <p className="font-medium text-foreground">{organization.name}</p>
            <p className="font-mono text-xs text-muted-foreground">
              {organization.slug}
            </p>
            {changeOrganizationHref ? (
              <div className="pt-1">
                <Button
                  href={changeOrganizationHref}
                  variant="quiet"
                  className="rounded-none px-0 text-zinc-300"
                >
                  Change organisation
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">Client ID:</span>{" "}
            <span className="font-mono">{clientId ?? "unknown"}</span>
          </p>
          <div className="space-y-1">
            <p className="text-muted-foreground">Requested scopes:</p>
            {scopes.length > 0 ? (
              <ul className="list-disc pl-5 text-foreground">
                {scopes.map((scope) => (
                  <li key={scope} className="font-mono text-xs">
                    {scope}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No scopes requested.</p>
            )}
          </div>
        </div>

        {error ? (
          <InlineAlert variant="error" title="Could not continue">
            {error}
          </InlineAlert>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            className="rounded-none"
            isDisabled={isSubmitting !== null}
            isPending={isSubmitting === "deny"}
            onPress={onDeny}
          >
            Deny
          </Button>
          <Button
            className="rounded-none"
            isDisabled={isSubmitting !== null}
            isPending={isSubmitting === "allow"}
            onPress={onAllow}
          >
            Allow
          </Button>
        </div>
      </section>
    </main>
  )
}
