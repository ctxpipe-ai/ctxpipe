"use client"

import { OrgAtlassianOauthPanel } from "../../OrgAtlassianOauthPanel"

type RegisterAtlassianOauthStepProps = {
  orgSlug: string
  atlassianConnectionId: string
}

export function RegisterAtlassianOauthStep({
  orgSlug,
  atlassianConnectionId,
}: RegisterAtlassianOauthStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Register Atlassian OAuth app
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Self-hosted deployments use their own OAuth 2.0 (3LO) client in the
          Atlassian developer console. Follow the steps below and save your
          Client ID and secret before linking an account.
        </p>
      </div>
      <OrgAtlassianOauthPanel
        embedded
        orgSlug={orgSlug}
        connectionId={atlassianConnectionId}
      />
    </div>
  )
}
