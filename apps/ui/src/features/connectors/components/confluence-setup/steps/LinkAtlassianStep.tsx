import { Button } from "@/components/ui/Button"
import { authClient } from "@/lib/auth-client"

type LinkAtlassianStepProps = {
  orgSlug: string
}

export function LinkAtlassianStep({ orgSlug }: LinkAtlassianStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Link Atlassian account
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect your Atlassian account to enable Confluence access for this
          organization.
        </p>
      </div>
      <Button
        variant="primary"
        className="rounded-none"
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
