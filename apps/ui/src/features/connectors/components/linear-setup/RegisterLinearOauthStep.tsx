"use client"

import { LinearOauthAppPanel } from "./LinearOauthAppPanel"

type RegisterLinearOauthStepProps = {
  orgSlug: string
  connectionId: string
}

/**
 * The Linear setup step of a self-hosted deployment where the admin creates a
 * Linear application and saves its credentials before connecting a workspace.
 */
export function RegisterLinearOauthStep({
  orgSlug,
  connectionId,
}: RegisterLinearOauthStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Register Linear OAuth app
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Create a Linear application for this deployment. Linear shows the
          client ID and client secret only after you click Create. Save those
          here with the webhook signing secret from the create form, then
          connect a workspace.
        </p>
      </div>
      <LinearOauthAppPanel orgSlug={orgSlug} connectionId={connectionId} />
    </div>
  )
}
