import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { InlineAlert } from "@/components/ui/InlineAlert"

const WRITE_SCOPE = "ctxpipe:write"

const SCOPE_TEXT: Record<string, string> = {
  "ctxpipe:read":
    "Read context: knowledge, code and the knowledge graph of this organization.",
  openid: "Confirm who you are.",
  profile: "See your name and picture.",
  email: "See your email address.",
  offline_access: "Stay connected when you are not signed in.",
}

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
  /** Receives the scopes the user allows: write only when ticked. */
  onAllow: (allowedScopes: string[]) => void
  onDeny: () => void
}) {
  const [allowWrite, setAllowWrite] = useState(false)
  const fixedScopes = scopes.filter((scope) => scope !== WRITE_SCOPE)
  const requestsWrite = scopes.includes(WRITE_SCOPE)
  const allowedScopes = allowWrite ? scopes : fixedScopes
  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-foreground">
      <section className="space-y-6 rounded-md border border-border bg-card/80 p-6">
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
                  className="rounded-md px-0 text-zinc-300"
                >
                  Change organisation
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <InlineAlert variant="error" title="Organisation unavailable">
            The organisation for this request could not be verified. Reload the
            page before allowing access.
          </InlineAlert>
        )}

        <div className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">Client ID:</span>{" "}
            <span className="font-mono">{clientId ?? "unknown"}</span>
          </p>
          <div className="space-y-1">
            <p className="text-muted-foreground">Requested access:</p>
            {fixedScopes.length > 0 ? (
              <ul className="list-disc pl-5 text-foreground">
                {fixedScopes.map((scope) => (
                  <li key={scope}>
                    {SCOPE_TEXT[scope] ?? (
                      <span className="font-mono text-xs">{scope}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : requestsWrite ? null : (
              <p>No access requested.</p>
            )}
            {requestsWrite ? (
              <Checkbox isSelected={allowWrite} onChange={setAllowWrite}>
                Also allow changes: propose and record knowledge in this
                organization. Leave this off for read-only access.
              </Checkbox>
            ) : null}
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
            className="rounded-md"
            isDisabled={isSubmitting !== null}
            isPending={isSubmitting === "deny"}
            onPress={onDeny}
          >
            Deny
          </Button>
          <Button
            className="rounded-md"
            isDisabled={
              isSubmitting !== null ||
              !organization ||
              allowedScopes.length === 0
            }
            isPending={isSubmitting === "allow"}
            onPress={() => onAllow(allowedScopes)}
          >
            Allow
          </Button>
        </div>
      </section>
    </main>
  )
}
