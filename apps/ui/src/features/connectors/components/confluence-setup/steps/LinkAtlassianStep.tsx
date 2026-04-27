import { Button } from "@/components/ui/Button"
import { authClient } from "@/lib/auth-client"

type LinkAtlassianStepProps = {
  orgSlug: string
}

export function LinkAtlassianStep({ orgSlug }: LinkAtlassianStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Link Atlassian account
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Connect your Atlassian account to enable Confluence access for this
          organization.
        </p>
      </div>
      <Button
        variant="primary"
        onPress={async () => {
          const target = `/${orgSlug}/connectors${window.location.search}`
          await authClient.linkSocial({
            provider: "atlassian",
            callbackURL: target,
            errorCallbackURL: target,
          })
        }}
      >
        Connect Atlassian account
      </Button>
    </div>
  )
}
