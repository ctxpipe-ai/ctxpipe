import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { useConfluenceForgeRuntime } from "@/providers/ConfluenceForgeRuntimeContext"
import {
  atlassianConnectorKeys,
  fetchOrgCapabilities,
  registerAtlassianInstallIntent,
} from "../../../queries/atlassian-connector"
import { CONFLUENCE_FORGE_INSTALL_URL } from "../forge-install-url"

type InstallForgeStepProps = {
  orgSlug: string
  atlassianConnectionId: string
  onOpenedInstall: () => void
}

export function InstallForgeStep({
  orgSlug,
  atlassianConnectionId,
  onOpenedInstall,
}: InstallForgeStepProps) {
  const queryClient = useQueryClient()
  const forgeRuntime = useConfluenceForgeRuntime()
  const caps = useQuery({
    queryKey: atlassianConnectorKeys.capabilities(
      orgSlug,
      atlassianConnectionId,
    ),
    queryFn: () => fetchOrgCapabilities(orgSlug, atlassianConnectionId),
  })

  const installUrl =
    caps.data?.confluenceForgeInstallUrl?.trim() ||
    forgeRuntime.installUrlFallback ||
    CONFLUENCE_FORGE_INSTALL_URL

  const hasHostedInstall = Boolean(installUrl?.startsWith("https://"))

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
          {hasHostedInstall
            ? "Install the CtxPipe Forge app to your Confluence workspace. A new window will open to the Atlassian install flow."
            : "This deployment has no hosted marketplace URL. Use the product Provision step so the worker can run `forge install` against your Confluence site."}
        </p>
      </div>
      <div className="space-y-3">
        {hasHostedInstall ? (
          <>
            <Button
              variant="primary"
              isPending={installIntentMutation.isPending}
              onPress={async () => {
                installIntentMutation.mutateAsync()
                window.open(
                  installUrl,
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
          </>
        ) : (
          <p className="text-sm text-zinc-500">
            Polling in the next step will detect installation when the Forge app
            is available on your site.
          </p>
        )}
        {caps.isError ? (
          <p className="text-sm text-amber-200/90">
            Could not load instance capabilities; using the default install link
            from build config when present.
          </p>
        ) : null}
      </div>
    </div>
  )
}
