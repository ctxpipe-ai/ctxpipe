import { Button } from "@/components/ui/Button"
import { SpacePageTree } from "./SpacePageTree"
import type { AtlassianConnectorConfig, SpaceScopeItem } from "./types"
import { useMutation, useQuery } from "@tanstack/react-query"
import { IconLoader2 } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

interface EditScopeModalProps {
  orgSlug: string
  onClose: () => void
}

export function EditScopeModal({ orgSlug, onClose }: EditScopeModalProps) {
  const [scope, setScope] = useState<SpaceScopeItem[]>([])
  const [scopeInitialized, setScopeInitialized] = useState(false)

  const { data: savedScope, isLoading: isLoadingScope } = useQuery({
    queryKey: ["atlassian-scope", orgSlug],
    queryFn: async () => {
      const res = await fetch(`/${orgSlug}/api/v1/connectors/atlassian/config`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error("Failed to load saved scope")
      return (await res.json()) as AtlassianConnectorConfig
    },
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
      const syncTarget = savedScope?.syncTarget
      if (!syncTarget) {
        throw new Error("Sync target is not configured. Complete setup first.")
      }
      const res = await fetch(`/${orgSlug}/api/v1/connectors/atlassian/config`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaces: scope,
          syncTarget: {
            repositoryName: syncTarget.repositoryName,
            branch: syncTarget.branch,
            enabled: syncTarget.enabled,
          },
        }),
      })
      if (!res.ok) {
        const errorBody = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(errorBody.error ?? "Failed to save scope")
      }
      return (await res.json()) as { savedCount: number }
    },
    onSuccess: ({ savedCount }) => {
      toast.success(`Scope saved (${savedCount} space${savedCount === 1 ? "" : "s"})`)
      onClose()
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <div
      className="flex flex-col rounded-lg bg-zinc-900 shadow-xl"
      style={{ width: "780px", height: "660px" }}
    >
      <div className="shrink-0 px-6 pb-4 pt-6">
        <h2 className="mb-1 text-xl font-semibold text-zinc-100">
          Configure Confluence scope
        </h2>
        <p className="text-sm text-zinc-400">
          Select which spaces and pages ctxpipe should ingest from Confluence.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-6">
        {isLoadingScope ? (
          <div className="flex items-center gap-2 pt-4 text-sm text-zinc-500">
            <IconLoader2 className="h-4 w-4 animate-spin" />
            Loading saved scope...
          </div>
        ) : (
          <SpacePageTree orgSlug={orgSlug} value={scope} onChange={setScope} />
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800 px-6 py-4">
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
