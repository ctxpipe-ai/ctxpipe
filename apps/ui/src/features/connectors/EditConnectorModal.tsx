import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"
import type { Connector } from "./types"

interface EditCredentialsModalProps {
  connector: Connector
  onClose: () => void
  onSubmit: (data: {
    githubRepoName?: string
    githubBranch?: string
    config?: {
      syncMode?: "pr" | "auto"
      schedule?: "hourly" | "daily" | "manual"
      githubToken?: string
      confluenceApiToken?: string
      confluenceEmail?: string
      confluenceBaseUrl?: string
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
  const [githubRepoName, setGithubRepoName] = useState(
    connector.githubRepoName ?? "",
  )
  const [githubBranch, setGithubBranch] = useState(
    connector.githubBranch ?? "main",
  )
  const [githubToken, setGithubToken] = useState("")
  const [confluenceApiToken, setConfluenceApiToken] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const configUpdates: Record<string, string> = {}
    if (githubToken) configUpdates.githubToken = githubToken
    if (confluenceApiToken) configUpdates.confluenceApiToken = confluenceApiToken

    onSubmit({
      githubRepoName: githubRepoName || undefined,
      githubBranch: githubBranch || undefined,
      config:
        Object.keys(configUpdates).length > 0
          ? { ...connector.config, ...configUpdates }
          : undefined,
    })
  }

  const typeLabel =
    connector.type.charAt(0).toUpperCase() + connector.type.slice(1)

  return (
    <div className="w-full max-w-lg rounded-lg bg-zinc-900 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">
        Edit Credentials
      </h2>
      <p className="mb-4 text-sm text-zinc-400">{typeLabel}</p>

      {error && (
        <div className="mb-4 rounded-md bg-red-900/50 p-3 text-sm text-red-200">
          {error}
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

        {connector.type === "confluence" && (
          <TextField
            label="Confluence API Token (leave blank to keep existing)"
            type="password"
            value={confluenceApiToken}
            onChange={setConfluenceApiToken}
            placeholder="ATATT3x..."
            description="Rotate if your token has been revoked or expired"
          />
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button
            type="button"
            variant="secondary"
            onPress={onClose}
            isDisabled={isPending}
          >
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
