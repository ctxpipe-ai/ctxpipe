import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import {
  atlassianConnectorKeys,
  registerAtlassianInstallIntent,
} from "../../../queries/atlassian-connector"
import { CONFLUENCE_FORGE_INSTALL_URL } from "../forge-install-url"

type InstallForgeStepProps = {
  orgSlug: string
  atlassianConnectionId?: string
  onOpenedInstall: () => void
}

export function InstallForgeStep({
  orgSlug,
  atlassianConnectionId,
  onOpenedInstall,
}: InstallForgeStepProps) {
  const queryClient = useQueryClient()
  const installIntentMutation = useMutation({
    mutationFn: () => registerAtlassianInstallIntent(orgSlug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
      })
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Install Forge app
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Install the CtxPipe Forge app to your Confluence workspace. A popup
          will open for installation.
        </p>
      </div>
      <div className="space-y-3">
        <Button
          variant="primary"
          isPending={installIntentMutation.isPending}
          onPress={async () => {
            installIntentMutation.mutateAsync()
            window.open(
              CONFLUENCE_FORGE_INSTALL_URL,
              "ctxpipe-forge-install",
              "width=860,height=740",
            )
            onOpenedInstall()
            void queryClient.invalidateQueries({
              queryKey: atlassianConnectorKeys.status(
                orgSlug,
                atlassianConnectionId,
              ),
            })
          }}
        >
          Install Forge app
        </Button>
        {installIntentMutation.error ? (
          <p className="text-sm text-red-400">
            {installIntentMutation.error.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}
