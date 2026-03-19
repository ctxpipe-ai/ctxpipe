import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { client } from "@/lib/api"
import { useParams } from "@tanstack/react-router"
import { IconCheck, IconAlertTriangle } from "@tabler/icons-react"
import type { Connector } from "./types"

interface EditCredentialsModalProps {
  connector: Connector
  onClose: () => void
  onSubmit: (data: {
    githubRepoName?: string
    githubBranch?: string
    config?: {
      githubToken?: string
      confluenceBaseUrl?: string
      confluenceEmail?: string
      confluenceApiToken?: string
    }
  }) => void
  isPending?: boolean
  error?: string
}

export function EditConnectorModal({
  connector,
  onClose,
  onSubmit,
  isPending,
  error,
}: EditCredentialsModalProps) {
  const { orgSlug } = useParams({ from: "/$orgSlug/connectors" })
  const [githubRepoName, setGithubRepoName] = useState(connector.githubRepoName ?? "")
  const [githubBranch, setGithubBranch] = useState(connector.githubBranch ?? "main")
  const [githubToken, setGithubToken] = useState("")

  // Legacy fields — only shown for connectors still using basic auth
  const [confluenceApiToken, setConfluenceApiToken] = useState("")

  const typeLabel = connector.type.charAt(0).toUpperCase() + connector.type.slice(1)
  const isOAuthConnected = !!connector.config.oauthRefreshToken
  const isLegacy = !isOAuthConnected && !!connector.config.confluenceApiToken
  const isCloud = connector.config.deploymentType !== "datacenter"

  const reconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"]["oauth"]["start"].$get({
        param: { orgSlug, id: connector.id },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? "Failed to start OAuth")
      }
      const { url } = (await res.json()) as { url: string }
      return url
    },
    onSuccess: (url) => {
      window.location.href = url
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const configUpdates: Record<string, string> = {}
    if (githubToken) configUpdates.githubToken = githubToken
    if (confluenceApiToken) configUpdates.confluenceApiToken = confluenceApiToken

    onSubmit({
      githubRepoName: githubRepoName || undefined,
      githubBranch: githubBranch || undefined,
      config: Object.keys(configUpdates).length > 0
        ? { ...connector.config, ...configUpdates }
        : undefined,
    })
  }

  return (
    <div className="w-full max-w-lg rounded-lg bg-zinc-900 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">Edit Credentials</h2>
      <p className="mb-5 text-sm text-zinc-400">{typeLabel}</p>

      {error && (
        <div className="mb-4 rounded-md bg-red-900/50 p-3 text-sm text-red-200">{error}</div>
      )}

      {/* OAuth connection status */}
      {connector.type === "confluence" && (
        <div className={[
          "mb-5 flex items-start gap-3 rounded-lg border p-3",
          isOAuthConnected
            ? "border-teal-800 bg-teal-900/20"
            : "border-amber-800 bg-amber-900/20",
        ].join(" ")}>
          {isOAuthConnected ? (
            <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-400" />
          ) : (
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          )}
          <div className="flex-1 min-w-0">
            <p className={[
              "text-sm font-medium",
              isOAuthConnected ? "text-teal-300" : "text-amber-300",
            ].join(" ")}>
              {isOAuthConnected
                ? `Connected via OAuth (${isCloud ? "Atlassian Cloud" : "Data Center"})`
                : isLegacy
                  ? "Using legacy API token — consider migrating to OAuth"
                  : "Not connected — authorise access to start syncing"}
            </p>
            {isOAuthConnected && connector.config.cloudId && (
              <p className="mt-0.5 text-xs text-teal-600">
                Cloud ID: {connector.config.cloudId}
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            onPress={() => reconnectMutation.mutate()}
            isPending={reconnectMutation.isPending}
          >
            {isOAuthConnected ? "Reconnect" : "Connect via OAuth"}
          </Button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="GitHub Repository"
          value={githubRepoName}
          onChange={setGithubRepoName}
          placeholder="owner/repo"
          description="All connectors in this org must share the same repository"
          isRequired
        />
        <TextField
          label="GitHub Branch"
          value={githubBranch}
          onChange={setGithubBranch}
          placeholder="main"
        />
        <TextField
          label="GitHub Token (leave blank to keep existing)"
          type="password"
          value={githubToken}
          onChange={setGithubToken}
          placeholder="ghp_xxxxxxxxxxxx"
        />

        {/* Legacy: only show if connector still uses basic auth */}
        {isLegacy && connector.type === "confluence" && (
          <TextField
            label="Confluence API Token (leave blank to keep existing)"
            type="password"
            value={confluenceApiToken}
            onChange={setConfluenceApiToken}
            placeholder="ATATT3x..."
            description="Legacy — use 'Connect via OAuth' above to migrate"
          />
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" onPress={onClose} isDisabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isPending={isPending}>
            Save
          </Button>
        </div>
      </form>
    </div>
  )
}
