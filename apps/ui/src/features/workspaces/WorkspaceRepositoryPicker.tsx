import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { TextField } from "@/components/ui/TextField"
import { client } from "@/lib/api"
import { eligibleInstallationRepos } from "./gitUrl"
import { fetchWorkspaces, workspaceKeys } from "./queries"

type Mode = "select" | "create" | "paste"

export function WorkspaceRepositoryPicker(props: {
  orgSlug: string
  currentUrl?: string
  submitLabel: string
  pending?: boolean
  error?: string | null
  onSubmit: (gitUrl: string) => void
}) {
  const { orgSlug, currentUrl, submitLabel, pending, error, onSubmit } = props
  const [mode, setMode] = useState<Mode>(currentUrl ? "select" : "paste")
  const [gitUrl, setGitUrl] = useState("")

  const existing = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const takenUrls = (existing.data?.items ?? []).map(
    (item) => item.workspaceRepositoryUrl,
  )

  const reposQuery = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.repositories
          .$get as (arg: {
          param: { orgSlug: string }
          query: { per_page: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        query: { per_page: "100" },
      })
      if (!res.ok)
        return { repositories: [] as { name: string; clone_url: string }[] }
      return res.json() as Promise<{
        repositories: { name: string; clone_url: string }[]
      }>
    },
    enabled: mode === "select",
  })

  const eligibleRepos = eligibleInstallationRepos({
    repositories: reposQuery.data?.repositories ?? [],
    takenUrls,
    currentUrl,
  })

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={mode === "select" ? "primary" : "secondary"}
          onPress={() => setMode("select")}
        >
          Select GitHub
        </Button>
        <Button
          variant={mode === "create" ? "primary" : "secondary"}
          onPress={() => setMode("create")}
        >
          Create on GitHub
        </Button>
        <Button
          variant={mode === "paste" ? "primary" : "secondary"}
          onPress={() => setMode("paste")}
        >
          Paste URL
        </Button>
      </div>
      {error ? (
        <div className="mt-4">
          <InlineAlert variant="error" title="Could not save">
            {error}
          </InlineAlert>
        </div>
      ) : null}
      {mode === "paste" ? (
        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (gitUrl.trim()) onSubmit(gitUrl.trim())
          }}
        >
          <TextField
            label="Git URL"
            value={gitUrl}
            onChange={setGitUrl}
            placeholder="https://github.com/org/repo.git"
            isRequired
          />
          <Button type="submit" variant="primary" isDisabled={pending}>
            {submitLabel}
          </Button>
        </form>
      ) : null}
      {mode === "create" ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            Open GitHub to create the repository, then come back and select it.
            We do not create GitHub repositories for you.
          </p>
          <Button
            variant="primary"
            onPress={() => {
              window.open(
                "https://github.com/new",
                "_blank",
                "noopener,noreferrer",
              )
              setMode("select")
            }}
          >
            Open github.com/new
          </Button>
        </div>
      ) : null}
      {mode === "select" ? (
        <ul className="mt-6 space-y-1">
          {reposQuery.isPending ? (
            <li className="text-sm text-muted-foreground">
              Loading repositories…
            </li>
          ) : eligibleRepos.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              No installation repositories available. Connect GitHub under
              Connectors, or paste a git URL.
            </li>
          ) : (
            eligibleRepos.map((repo) => (
              <li key={repo.clone_url}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900"
                  disabled={pending}
                  onClick={() => onSubmit(repo.clone_url)}
                >
                  <span>{repo.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {repo.clone_url}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
