import { Button } from "@/components/ui/Button"
import { useState, useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { client } from "@/lib/api"
import { useParams } from "@tanstack/react-router"
import { SpacePageTree, type SpaceScopeItem } from "./SpacePageTree"
import type { Connector, ConnectorSpace } from "./types"
import { IconExternalLink, IconLoader2 } from "@tabler/icons-react"

interface EditScopeModalProps {
  connector: Connector
  onClose: () => void
}

export function EditScopeModal({ connector, onClose }: EditScopeModalProps) {
  const { orgSlug } = useParams({ from: "/$orgSlug/connectors" })
  const queryClient = useQueryClient()

  const [scope, setScope] = useState<SpaceScopeItem[]>([])
  const [scopeInitialised, setScopeInitialised] = useState(false)
  const [configPrUrl, setConfigPrUrl] = useState<string | null>(null)

  // Fetch saved scope from the connector detail endpoint
  const { data: savedDetail, isLoading: isLoadingScope } = useQuery({
    queryKey: ["connector-detail", connector.id],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"].$get({
        param: { orgSlug, id: connector.id },
      })
      if (!res.ok) throw new Error("Failed to load connector")
      return res.json() as Promise<Connector & { spaces: ConnectorSpace[] }>
    },
    throwOnError: false,
  })

  // Populate scope state once when saved data arrives
  useEffect(() => {
    if (scopeInitialised || !savedDetail?.spaces) return
    setScope(
      savedDetail.spaces.map((s) => ({
        spaceKey: s.spaceKey,
        spaceName: s.spaceName ?? undefined,
        selectedPageIds: s.selectedPageIds,
      })),
    )
    setScopeInitialised(true)
  }, [savedDetail, scopeInitialised])

  const scopeMutation = useMutation({
    mutationFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"].scope.$post(
        {
          json: { spaces: scope },
          param: { orgSlug, id: connector.id },
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to save scope",
        )
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      const result = data as { noChange?: boolean; prUrl?: string | null }
      if (result.noChange) {
        toast.success("Scope unchanged — no PR needed")
      } else if (result.prUrl) {
        setConfigPrUrl(result.prUrl)
        toast.success("Scope saved — PR opened for review")
      } else {
        toast.success("Scope saved")
      }
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const typeLabel =
    connector.type.charAt(0).toUpperCase() + connector.type.slice(1)
  const missingCredentials =
    !connector.config.confluenceBaseUrl ||
    !connector.config.confluenceEmail ||
    !connector.config.confluenceApiToken

  return (
    <div className="flex flex-col rounded-lg bg-zinc-900 shadow-xl" style={{ width: "780px", height: "660px" }}>
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h2 className="mb-1 text-xl font-semibold text-zinc-100">
          Configure Scope
        </h2>
        <p className="text-sm text-zinc-400">
          {typeLabel} — select spaces and pages to sync. Saving generates a{" "}
          <strong className="text-zinc-300">config.yaml</strong> PR in GitHub.
        </p>
      </div>

      {/* Tree area — SpacePageTree manages its own internal scroll */}
      <div className="min-h-0 flex-1 overflow-hidden px-6">
        {missingCredentials ? (
          <p className="rounded-md bg-amber-900/30 p-3 text-sm text-amber-300">
            Configure Confluence credentials first before selecting scope.
          </p>
        ) : isLoadingScope ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500 pt-4">
            <IconLoader2 className="h-4 w-4 animate-spin" />
            Loading saved scope…
          </div>
        ) : (
          <SpacePageTree
            connectorId={connector.id}
            orgSlug={orgSlug}
            value={scope}
            onChange={setScope}
          />
        )}
      </div>

      {/* Footer — always visible */}
      <div className="shrink-0 border-t border-zinc-800 px-6 py-4">
        {configPrUrl && (
          <a
            href={configPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-3 flex items-center gap-1.5 text-sm text-teal-400 hover:text-teal-300"
          >
            <IconExternalLink className="h-4 w-4" />
            View config PR on GitHub
          </a>
        )}
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
            isDisabled={missingCredentials}
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
