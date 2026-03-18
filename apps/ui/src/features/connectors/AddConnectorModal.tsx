import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"
import { client } from "@/lib/api"
import { useParams } from "@tanstack/react-router"
import { toast } from "sonner"
import { useMutation } from "@tanstack/react-query"
import type { Connector } from "./types"

interface AddConnectorModalProps {
  onClose: () => void
  onSuccess: () => void
}

export function AddConnectorModal({ onClose, onSuccess }: AddConnectorModalProps) {
  const { orgSlug } = useParams({ from: "/$orgSlug/connectors" })

  const [type] = useState("confluence")
  const [deploymentType, setDeploymentType] = useState<"cloud" | "datacenter">("cloud")
  const [confluenceBaseUrl, setConfluenceBaseUrl] = useState("")
  const [oauthClientId, setOauthClientId] = useState("")
  const [oauthClientSecret, setOauthClientSecret] = useState("")
  const [githubToken, setGithubToken] = useState("")
  const [githubRepoName, setGithubRepoName] = useState("")
  const [githubBranch, setGithubBranch] = useState("main")

  // Step 1: create connector → Step 2: redirect to Atlassian OAuth
  const createAndConnect = useMutation({
    mutationFn: async () => {
      const createRes = await client[":orgSlug"].api.v1.connectors.$post({
        json: {
          type,
          githubRepoName: githubRepoName || undefined,
          githubBranch: githubBranch || undefined,
          config: {
            deploymentType,
            githubToken: githubToken || undefined,
            confluenceBaseUrl: confluenceBaseUrl || undefined,
            oauthClientId: oauthClientId || undefined,
            oauthClientSecret: oauthClientSecret || undefined,
          },
        },
        param: { orgSlug },
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? "Failed to create connector")
      }
      const connector = (await createRes.json()) as Connector

      // Fetch the OAuth start URL
      const startRes = await client[":orgSlug"].api.v1.connectors[":id"]["oauth"]["start"].$get({
        param: { orgSlug, id: connector.id },
      })
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? "Failed to start OAuth")
      }
      const { url } = (await startRes.json()) as { url: string }
      return url
    },
    onSuccess: (url) => {
      onSuccess()
      window.location.href = url
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const isCloud = deploymentType === "cloud"

  return (
    <div className="w-full max-w-lg rounded-lg bg-zinc-900 p-6 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold text-zinc-100">Add Connector</h2>
      <p className="mb-5 text-sm text-zinc-400">
        Connect an external source. You'll be redirected to authorise access via OAuth.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          createAndConnect.mutate()
        }}
        className="space-y-4"
      >
        {/* Deployment type */}
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">
            Confluence deployment
          </label>
          <div className="flex gap-3">
            {(["cloud", "datacenter"] as const).map((dt) => (
              <label
                key={dt}
                className={[
                  "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  deploymentType === dt
                    ? "border-teal-500 bg-teal-900/20 text-teal-300"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500",
                ].join(" ")}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="deploymentType"
                  value={dt}
                  checked={deploymentType === dt}
                  onChange={() => setDeploymentType(dt)}
                />
                {dt === "cloud" ? "Atlassian Cloud" : "Data Center (self-hosted)"}
              </label>
            ))}
          </div>
          {isCloud && (
            <p className="mt-1.5 text-xs text-zinc-500">
              Requires <code className="text-zinc-400">ATLASSIAN_CLIENT_ID</code> and{" "}
              <code className="text-zinc-400">ATLASSIAN_CLIENT_SECRET</code> to be set in the backend.
            </p>
          )}
        </div>

        {/* Confluence instance URL — always shown */}
        <TextField
          label={isCloud ? "Confluence Cloud URL" : "Confluence instance URL"}
          type="url"
          value={confluenceBaseUrl}
          onChange={setConfluenceBaseUrl}
          placeholder={isCloud ? "https://your-org.atlassian.net" : "https://confluence.company.com"}
          description={
            isCloud
              ? "Used to match your site after OAuth — optional if you only have one Atlassian site"
              : "Your self-hosted Confluence instance"
          }
          isRequired={!isCloud}
        />

        {/* DC-only: OAuth application link credentials */}
        {!isCloud && (
          <>
            <TextField
              label="OAuth Client ID"
              value={oauthClientId}
              onChange={setOauthClientId}
              placeholder="From Settings → Application Links"
              isRequired
            />
            <TextField
              label="OAuth Client Secret"
              type="password"
              value={oauthClientSecret}
              onChange={setOauthClientSecret}
              placeholder="From Settings → Application Links"
              isRequired
            />
          </>
        )}

        <hr className="border-zinc-800" />

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

        <div className="flex justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            onPress={onClose}
            isDisabled={createAndConnect.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isPending={createAndConnect.isPending}>
            Create & Connect →
          </Button>
        </div>
      </form>
    </div>
  )
}
