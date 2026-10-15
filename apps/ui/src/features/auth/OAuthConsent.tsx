import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { OrganizationPicker } from "@/features/auth/OrganizationPicker"

const WRITE_SCOPE = "ctxpipe:write"

const SCOPE_TEXT: Record<string, string> = {
  "ctxpipe:read":
    "Read context: knowledge, code and the knowledge graph of the selected organizations.",
  openid: "Confirm who you are.",
  profile: "See your name and picture.",
  email: "See your email address.",
  offline_access: "Stay connected when you are not signed in.",
}

export type OAuthConsentOrganization = {
  id: string
  name: string
  slug: string
}

export function OAuthConsent({
  clientId,
  scopes,
  organizations,
  defaultOrganizationIds,
  error = null,
  isSubmitting = null,
  onAllow,
  onDeny,
}: {
  clientId: string | null
  scopes: string[]
  /** The orgs of the user. Empty when they could not be loaded. */
  organizations: OAuthConsentOrganization[]
  /** Ticked at first: the current org. */
  defaultOrganizationIds: string[]
  error?: string | null
  isSubmitting?: "allow" | "deny" | null
  /**
   * Receives the scopes the user allows (write only when ticked) and the
   * ticked orgs (at least one).
   */
  onAllow: (allowedScopes: string[], organizationIds: string[]) => void
  onDeny: () => void
}) {
  const [allowWrite, setAllowWrite] = useState(false)
  const [organizationIds, setOrganizationIds] = useState(defaultOrganizationIds)
  const fixedScopes = scopes.filter((scope) => scope !== WRITE_SCOPE)
  const requestsWrite = scopes.includes(WRITE_SCOPE)
  const allowedScopes = allowWrite ? scopes : fixedScopes
  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-foreground">
      <section className="space-y-6 rounded-md border border-border bg-card/80 p-6">
        <div className="space-y-2">
          <p className="ctx-label">OAuth connection</p>
          <h1 className="text-xl font-medium">Authorize client</h1>
          <p className="text-sm text-muted-foreground">
            The client below asks for access to ctx| data. It can reach only the
            organizations you select. You can change them later in Connected
            apps.
          </p>
        </div>

        {organizations.length > 0 ? (
          <OrganizationPicker
            organizations={organizations}
            value={organizationIds}
            onChange={setOrganizationIds}
          />
        ) : (
          <InlineAlert variant="error" title="Organizations unavailable">
            We could not load your organizations. Reload the page before you
            allow access.
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
                Also allow changes: propose and record knowledge in the selected
                organizations. Leave this off for read-only access.
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
              organizationIds.length === 0 ||
              allowedScopes.length === 0
            }
            isPending={isSubmitting === "allow"}
            onPress={() => onAllow(allowedScopes, organizationIds)}
          >
            Allow
          </Button>
        </div>
      </section>
    </main>
  )
}
