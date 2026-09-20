"use client"

import { OrgNotionOauthPanel } from "../OrgNotionOauthPanel"

type RegisterNotionOauthStepProps = {
  orgSlug: string
  connectionId: string
  onConnect: () => void
  connectPending?: boolean
}

export function RegisterNotionOauthStep({
  orgSlug,
  connectionId,
  onConnect,
  connectPending,
}: RegisterNotionOauthStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Register Notion integration
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Self-hosted deployments use their own public Notion integration.
          Create it in Notion, save the client ID and secret here, then complete
          webhook verification before connecting a workspace.
        </p>
      </div>
      <OrgNotionOauthPanel
        embedded
        orgSlug={orgSlug}
        connectionId={connectionId}
        onConnect={onConnect}
        connectPending={connectPending}
      />
    </div>
  )
}
