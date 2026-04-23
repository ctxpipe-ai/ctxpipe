import { IconLoader2 } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorConfig,
  patchAtlassianConnectorConfig,
} from "./queries/atlassian-connector"
import { SpacePageTree } from "./SpacePageTree"
import type { SpaceScopeItem } from "./types"

interface EditScopeModalProps {
  orgSlug: string
  atlassianConnectionId: string
  onClose: () => void
}

export function EditScopeModal({
  orgSlug,
  atlassianConnectionId,
  onClose,
}: EditScopeModalProps) {
  const queryClient = useQueryClient()
  const [scope, setScope] = useState<SpaceScopeItem[]>([])
  const [scopeInitialized, setScopeInitialized] = useState(false)

  const {
    data: savedScope,
    isLoading: isLoadingScope,
    isError: scopeLoadError,
  } = useQuery({
    queryKey: atlassianConnectorKeys.config(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorConfig(orgSlug, atlassianConnectionId),
    throwOnError: false,
  })

  useEffect(() => {
    if (scopeInitialized || !savedScope) return
    setScope(
      savedScope.spaces.map((row) => ({
        spaceKey: row.spaceKey,
        spaceName: row.spaceName ?? undefined,
        selectedPageIds: row.selectedPageIds,
      })),
    )
    setScopeInitialized(true)
  }, [savedScope, scopeInitialized])

  const scopeMutation = useMutation({
    mutationFn: async () => {
      if (!savedScope?.syncTarget) {
        throw new Error("Sync target is not configured. Complete setup first.")
      }
      return patchAtlassianConnectorConfig(
        orgSlug,
        { spaces: scope },
        atlassianConnectionId,
      )
    },
    onSuccess: async ({ savedCount, syncEnqueued }) => {
      const base = `Scope saved (${savedCount} space${savedCount === 1 ? "" : "s"})`
      toast.success(syncEnqueued ? `${base} Full sync has been queued.` : base)
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.config(orgSlug, atlassianConnectionId),
      })
      onClose()
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-col bg-zinc-900 shadow-xl sm:rounded-lg h-[min(660px,calc(var(--visual-viewport-height)*0.88))]">
      <div className="shrink-0 px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
        <h2 className="mb-1 text-xl font-semibold text-zinc-100">
          Configure Confluence scope
        </h2>
        <p className="text-sm leading-snug text-zinc-400">
          Select which spaces and pages ctxpipe should ingest from Confluence.
        </p>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-4 sm:px-6">
        {isLoadingScope ? (
          <div className="flex items-center gap-2 pt-4 text-sm text-zinc-500">
            <IconLoader2 className="h-4 w-4 animate-spin" />
            Loading saved scope...
          </div>
        ) : scopeLoadError ? (
          <p className="pt-4 text-sm text-red-400">
            Could not load Confluence configuration. Try again from the
            connectors page.
          </p>
        ) : savedScope === null ? (
          <div className="space-y-3 pt-4 text-sm text-zinc-400">
            <p>
              The Forge app must be installed before you can edit scope. Finish
              setup on the{" "}
              <Link
                to="/$orgSlug/connectors"
                params={{ orgSlug }}
                className="text-teal-500 underline-offset-2 hover:underline"
              >
                Connectors
              </Link>{" "}
              page first.
            </p>
          </div>
        ) : (
          <SpacePageTree
            orgSlug={orgSlug}
            atlassianConnectionId={atlassianConnectionId}
            value={scope}
            onChange={setScope}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800 px-4 py-4 sm:px-6">
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onPress={onClose}
            isDisabled={scopeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            isPending={scopeMutation.isPending}
            isDisabled={scopeLoadError || savedScope === null || isLoadingScope}
            onPress={() => {
              if (scope.length === 0) {
                toast.error("Select at least one space before saving.")
                return
              }
              scopeMutation.mutate()
            }}
          >
            Save Scope
          </Button>
        </div>
      </div>
    </div>
  )
}
