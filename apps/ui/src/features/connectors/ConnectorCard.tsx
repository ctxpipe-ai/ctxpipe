import { Button } from "@/components/ui/Button"
import { IconTrash, IconRefresh, IconPencil, IconListTree } from "@tabler/icons-react"
import type { Connector } from "./types"
import { useState } from "react"
import { toast } from "sonner"
import { client } from "@/lib/api"
import { useParams } from "@tanstack/react-router"

interface ConnectorCardProps {
  connector: Connector
  onDelete: (connector: Connector) => void
  onEdit: (connector: Connector, tab?: "credentials" | "scope") => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ConnectorCard({
  connector,
  onDelete,
  onEdit,
}: ConnectorCardProps) {
  const [isSyncing, setIsSyncing] = useState(false)
  const { orgSlug } = useParams({ from: "/$orgSlug/connectors" })

  const handleSync = async () => {
    setIsSyncing(true)
    try {
      const res = await client[":orgSlug"].api.v1.connectors[":id"].sync.$post({
        param: { orgSlug, id: connector.id },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? "Failed to trigger sync")
      }
      toast.success("Sync triggered")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger sync")
    } finally {
      setIsSyncing(false)
    }
  }

  const label = connector.type.charAt(0).toUpperCase() + connector.type.slice(1)

  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      {/* Name + last sync */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{label}</span>
          <span
            className={[
              "rounded-full px-2 py-0.5 text-xs",
              connector.enabled
                ? "bg-zinc-700 text-zinc-300"
                : "bg-zinc-800 text-zinc-600",
            ].join(" ")}
            title="Whether this connector is enabled — does not indicate connection health"
          >
            {connector.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          {connector.lastSyncAt
            ? `Last sync ${relativeTime(connector.lastSyncAt)}`
            : "Never synced"}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          onPress={handleSync}
          isPending={isSyncing}
          isDisabled={!connector.enabled}
          aria-label="Sync now"
        >
          <IconRefresh className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          onPress={() => onEdit(connector, "scope")}
          aria-label="Configure scope"
        >
          <IconListTree className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          onPress={() => onEdit(connector, "credentials")}
          aria-label="Edit credentials"
        >
          <IconPencil className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          onPress={() => onDelete(connector)}
          aria-label="Delete connector"
        >
          <IconTrash className="h-4 w-4 text-red-400" />
        </Button>
      </div>
    </div>
  )
}
