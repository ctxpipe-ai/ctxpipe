import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  createFileRoute,
  Navigate,
  useNavigate,
} from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

export const Route = createFileRoute("/$orgSlug/github/setup")({
  component: GitHubSetupPage,
})

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

function GitHubSetupPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()
  const navigate = useNavigate()

  const [includeFutureRepos, setIncludeFutureRepos] = useState(false)
  const [selectedValues, setSelectedValues] = useState<string[]>([])

  const { data: repos = [], isPending: reposPending } = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: async () => {
      const res = await client[
        ":orgSlug"
      ].api.v1.github.installation.repositories.$get({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as { repositories: GitHubRepoItem[] }
      return json.repositories
    },
    enabled: !!session,
  })

  const repoIds = useMemo(() => repos.map((r) => String(r.id)), [repos])
  const allSelected = repos.length > 0 && selectedValues.length === repos.length

  const handleSelectAllChange = useCallback(
    (checked: boolean) => {
      setSelectedValues(checked ? repoIds : [])
    },
    [repoIds],
  )

  const updateOptionsMutation = useMutation({
    mutationFn: async () => {
      const selectedSet = new Set(selectedValues)
      const selectedRepositories = repos.filter((r) =>
        selectedSet.has(String(r.id)),
      )
      const res = await client[":orgSlug"].api.v1.github.installation.$patch({
        param: { orgSlug },
        json: {
          ingestAllRepositories: allSelected,
          includeFutureRepos: allSelected ? includeFutureRepos : false,
          selectedRepositories,
        },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? "Failed to save")
      }
    },
    onSuccess: () => {
      toast.success("Repositories saved. Ingestion has started.")
      navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedValues.length === 0) {
      toast.error("Select at least one repository")
      return
    }
    updateOptionsMutation.mutate()
  }

  if (sessionPending) return null
  if (!session) {
    return (
      <Navigate
        to="/.auth/sign-in"
        search={{ redirectTo: `/${orgSlug}/github/setup` }}
        replace
      />
    )
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl px-6 py-10 text-zinc-200">
        <h1 className="text-2xl font-semibold text-zinc-50">
          GitHub repository setup
        </h1>
        <p className="mt-2 text-zinc-300">
          Choose which repositories to ingest. You can select all or pick
          specific ones.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-8 space-y-6 [&_label]:text-zinc-200!"
        >
          <div className="flex min-w-0 items-center gap-2 border-b border-zinc-700 pb-2">
            <Checkbox
              aria-label="Select all repositories"
              isSelected={allSelected}
              onChange={handleSelectAllChange}
            />
            <span className="min-w-0 shrink text-sm font-medium">
              Select all
            </span>
          </div>
          <CheckboxGroup
            label="Repositories"
            value={selectedValues}
            onChange={setSelectedValues}
            className="gap-3"
          >
            {reposPending ? (
              <p className="text-sm text-zinc-300">Loading repositories…</p>
            ) : repos.length === 0 ? (
              <p className="text-sm text-zinc-300">
                No repositories found for this installation.
              </p>
            ) : (
              <ul className="flex min-w-0 flex-col gap-2">
                {repos.map((repo) => (
                  <li
                    key={repo.id}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <Checkbox
                      value={String(repo.id)}
                      aria-label={`Select ${repo.full_name}`}
                      className="min-w-0"
                    >
                      <span className="min-w-0 truncate">
                        {repo.full_name}
                      </span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            )}
          </CheckboxGroup>

          {allSelected && repos.length > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="include-future"
                isSelected={includeFutureRepos}
                onChange={(v) => setIncludeFutureRepos(v)}
              />
              <label
                htmlFor="include-future"
                className="text-sm text-zinc-200"
              >
                Also enable repositories added in the future
              </label>
            </div>
          )}

          <div className="flex gap-3">
            <Button
              type="submit"
              variant="primary"
              isDisabled={updateOptionsMutation.isPending}
            >
              {updateOptionsMutation.isPending
                ? "Saving…"
                : "Save and start ingestion"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onPress={() =>
                navigate({
                  to: "/$orgSlug/repositories",
                  params: { orgSlug },
                })
              }
            >
              Cancel
            </Button>
          </div>
        </form>
      </main>
    </AppShell>
  )
}
