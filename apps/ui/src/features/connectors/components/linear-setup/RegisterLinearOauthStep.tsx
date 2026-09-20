"use client"

import { LinearOauthAppPanel } from "./LinearOauthAppPanel"

type RegisterLinearOauthStepProps = {
  orgSlug: string
  connectionId: string
}

export function RegisterLinearOauthStep({
  orgSlug,
  connectionId,
}: RegisterLinearOauthStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Register Linear OAuth app
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Self-hosted deployments use their own Linear OAuth application. Create
          it in Linear, then save the client ID, client secret, and webhook
          signing secret here before connecting a workspace.
        </p>
      </div>
      <LinearOauthAppPanel orgSlug={orgSlug} connectionId={connectionId} />
    </div>
  )
}
