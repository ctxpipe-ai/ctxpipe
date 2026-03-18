import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"

interface AddConnectorModalProps {
  onClose: () => void
  onSubmit: (data: {
    type: string
    githubRepoName?: string
    githubBranch?: string
    config: {
      confluenceBaseUrl?: string
      confluenceEmail?: string
      confluenceApiToken?: string
      githubToken?: string
    }
  }) => void
  isPending?: boolean
  error?: string
}

export function AddConnectorModal({
  onClose,
  onSubmit,
  isPending,
  error,
}: AddConnectorModalProps) {
  const [type, setType] = useState("confluence")
  const [confluenceBaseUrl, setConfluenceBaseUrl] = useState("")
  const [confluenceEmail, setConfluenceEmail] = useState("")
  const [confluenceApiToken, setConfluenceApiToken] = useState("")
  const [githubToken, setGithubToken] = useState("")
  const [githubRepoName, setGithubRepoName] = useState("")
  const [githubBranch, setGithubBranch] = useState("main")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      type,
      githubRepoName: githubRepoName || undefined,
      githubBranch: githubBranch || undefined,
      config: {
        confluenceBaseUrl: confluenceBaseUrl || undefined,
        confluenceEmail: confluenceEmail || undefined,
        confluenceApiToken: confluenceApiToken || undefined,
        githubToken: githubToken || undefined,
      },
    })
  }

  return (
    <div className="w-full max-w-lg rounded-lg bg-zinc-900 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">
        Add Connector
      </h2>
      <p className="mb-4 text-sm text-zinc-400">
        Connect an external source. After creating, use the scope button to
        select which spaces and pages to sync.
      </p>

      {error && (
        <div className="mb-4 rounded-md bg-red-900/50 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="connector-type"
            className="mb-1 block text-sm font-medium text-zinc-300"
          >
            Type
          </label>
          <select
            id="connector-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 focus:border-teal-500 focus:outline-none"
          >
            <option value="confluence">Confluence</option>
          </select>
        </div>

        {type === "confluence" && (
          <>
            <TextField
              label="Confluence Base URL"
              type="url"
              value={confluenceBaseUrl}
              onChange={setConfluenceBaseUrl}
              placeholder="https://your-domain.atlassian.net"
              isRequired
            />

            <TextField
              label="Confluence Email"
              type="email"
              value={confluenceEmail}
              onChange={setConfluenceEmail}
              placeholder="you@example.com"
              isRequired
            />

            <TextField
              label="Confluence API Token"
              type="password"
              value={confluenceApiToken}
              onChange={setConfluenceApiToken}
              placeholder="your-api-token"
              isRequired
            />
          </>
        )}

        <TextField
          label="GitHub Token"
          type="password"
          value={githubToken}
          onChange={setGithubToken}
          placeholder="ghp_xxxxxxxxxxxx"
          isRequired
        />

        <TextField
          label="GitHub Repository"
          value={githubRepoName}
          onChange={setGithubRepoName}
          placeholder="owner/repo"
          description="All connectors in this org share one repository"
          isRequired
        />

        <TextField
          label="GitHub Branch"
          value={githubBranch}
          onChange={setGithubBranch}
          placeholder="main"
        />

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
            Create Connector
          </Button>
        </div>
      </form>
    </div>
  )
}
