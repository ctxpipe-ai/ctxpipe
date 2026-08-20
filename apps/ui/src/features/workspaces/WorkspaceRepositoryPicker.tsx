import { IconExternalLink } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link, TextField as AriaTextField } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { FieldGroup, Input, Label } from "@/components/ui/Field"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { SearchField } from "@/components/ui/SearchField"
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/Tabs"
import { GithubRepoPickerList } from "@/features/repositories/components/GithubRepoPickerList"
import {
  collectInstallationRepoPages,
  fetchGithubInstallationReposPage,
  type GithubRepoItem,
} from "@/features/repositories/githubRepoSelection"
import { gitSourceMatchesQuery } from "@/features/repositories/gitSourcesFilter"
import { focusVisibleClassName } from "@/lib/focus-styles"
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
  const [mode, setMode] = useState<Mode>("select")
  const [gitUrl, setGitUrl] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const existing = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const takenUrls = (existing.data?.items ?? []).map(
    (item) => item.workspaceRepositoryUrl,
  )

  const reposQuery = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: () =>
      collectInstallationRepoPages((page) =>
        fetchGithubInstallationReposPage(orgSlug, page),
      ),
    refetchOnWindowFocus: "always",
  })

  const eligibleRepos = useMemo(
    () =>
      eligibleInstallationRepos({
        repositories: reposQuery.data?.repositories ?? [],
        takenUrls,
        currentUrl,
      }),
    [reposQuery.data?.repositories, takenUrls, currentUrl],
  )

  const filteredRepos = useMemo(
    () =>
      eligibleRepos.filter((repo) =>
        gitSourceMatchesQuery(repo.full_name, repo.clone_url, searchQuery),
      ),
    [eligibleRepos, searchQuery],
  )

  const selectedRepo =
    eligibleRepos.find((repo) => repo.id === selectedId) ?? null
  const selectedIds = new Set(selectedRepo ? [selectedRepo.id] : [])
  const repositorySelection = reposQuery.data?.repositorySelection
  const manageUrl = reposQuery.data?.manageUrl ?? null
  const accessRepoCount =
    reposQuery.data?.totalCount ?? reposQuery.data?.repositories.length ?? 0
  const accessReady = reposQuery.isSuccess

  return (
    <div>
      {error ? (
        <div className="mb-4">
          <InlineAlert variant="error" title="Could not save">
            {error}
          </InlineAlert>
        </div>
      ) : null}
      <Tabs
        selectedKey={mode}
        onSelectionChange={(key) => {
          if (key === "select" || key === "create" || key === "paste") {
            setMode(key)
          }
        }}
        className="gap-3"
      >
        <TabList
          aria-label="How to choose the repository"
          className="m-0 rounded-full bg-zinc-800 p-1"
        >
          <Tab id="select">Select GitHub</Tab>
          <Tab id="create">Create on GitHub</Tab>
          <Tab id="paste">Paste URL</Tab>
        </TabList>
        <div className="relative overflow-hidden">
          <TabPanel id="select" className="p-0">
            <SelectGitHubPanel
              pending={pending}
              submitLabel={submitLabel}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              filteredRepos={filteredRepos}
              eligibleCount={eligibleRepos.length}
              selectedIds={selectedIds}
              selectedRepoUrl={selectedRepo?.clone_url ?? null}
              reposPending={reposQuery.isPending}
              reposFailed={reposQuery.isError}
              onToggle={(id, selected) => {
                setSelectedId(selected ? id : null)
              }}
              onSubmit={onSubmit}
              accessReady={accessReady}
              repositorySelection={repositorySelection}
              accessRepoCount={accessRepoCount}
              manageUrl={manageUrl}
            />
          </TabPanel>
          <TabPanel id="create" className="p-0">
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Open GitHub to create the repository, then come back and select
                it. We do not create GitHub repositories for you.
              </p>
              <Button
                variant="secondary"
                onPress={() => {
                  window.open(
                    "https://github.com/new",
                    "_blank",
                    "noopener,noreferrer",
                  )
                  setMode("select")
                }}
              >
                Open GitHub
              </Button>
            </div>
          </TabPanel>
          <TabPanel id="paste" className="p-0">
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (gitUrl.trim()) onSubmit(gitUrl.trim())
              }}
            >
              <AriaTextField
                className="flex min-w-0 flex-1 flex-col gap-1"
                value={gitUrl}
                onChange={setGitUrl}
                isRequired
              >
                <Label>Git URL</Label>
                <FieldGroup>
                  <Input placeholder="https://github.com/org/repo.git" />
                </FieldGroup>
              </AriaTextField>
              <Button
                type="submit"
                variant="primary"
                className="shrink-0"
                isDisabled={pending || !gitUrl.trim()}
              >
                {submitLabel}
              </Button>
            </form>
          </TabPanel>
        </div>
      </Tabs>
    </div>
  )
}

function SelectGitHubPanel(props: {
  pending?: boolean
  submitLabel: string
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  filteredRepos: readonly GithubRepoItem[]
  eligibleCount: number
  selectedIds: Set<number>
  selectedRepoUrl: string | null
  reposPending: boolean
  reposFailed: boolean
  onToggle: (id: number, selected: boolean) => void
  onSubmit: (gitUrl: string) => void
  accessReady: boolean
  repositorySelection: string | undefined
  accessRepoCount: number
  manageUrl: string | null
}) {
  const accessLine = (
    <GithubAppAccessLine
      ready={props.accessReady}
      repositorySelection={props.repositorySelection}
      repoCount={props.accessRepoCount}
      manageUrl={props.manageUrl}
    />
  )

  if (props.reposPending) {
    return <InlineLoader label="Loading repositories" />
  }

  if (props.reposFailed) {
    return (
      <InlineAlert variant="error" title="Couldn’t load repositories">
        Connect GitHub under Connectors, or paste a git URL.
      </InlineAlert>
    )
  }

  if (props.eligibleCount === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          No installation repositories available. Connect GitHub under
          Connectors, or paste a git URL.
        </p>
        {accessLine}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <SearchField
        value={props.searchQuery}
        onChange={props.onSearchQueryChange}
        placeholder="Search repositories"
        aria-label="Search GitHub repositories"
      />
      {props.filteredRepos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repositories match.</p>
      ) : (
        <GithubRepoPickerList
          repos={props.filteredRepos}
          selectedIds={props.selectedIds}
          onToggle={props.onToggle}
          className="rounded-lg border-border bg-zinc-900/40"
        />
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        {accessLine}
        {props.selectedRepoUrl ? (
          <Button
            variant="primary"
            className="ml-auto shrink-0"
            isDisabled={props.pending}
            onPress={() => {
              if (props.selectedRepoUrl) props.onSubmit(props.selectedRepoUrl)
            }}
          >
            {props.submitLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function GithubAppAccessLine(props: {
  ready: boolean
  repositorySelection: string | undefined
  repoCount: number
  manageUrl: string | null
}) {
  if (!props.ready) return null
  if (
    props.repositorySelection !== "all" &&
    props.repositorySelection !== "selected"
  ) {
    return null
  }

  return (
    <p className="text-sm text-muted-foreground">
      ctxpipe has access to{" "}
      {props.repositorySelection === "all" ? (
        <strong className="font-medium text-foreground">
          all repositories
        </strong>
      ) : (
        <>
          <strong className="font-medium tabular-nums text-foreground">
            {props.repoCount}
          </strong>
          {props.repoCount === 1 ? " repository" : " repositories"}
        </>
      )}
      {props.manageUrl ? (
        <>
          .{" "}
          <Link
            href={props.manageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${focusVisibleClassName} inline-flex items-center gap-1 rounded-sm text-teal-400 hover:text-teal-300`}
          >
            Change access
            <IconExternalLink className="size-3.5" aria-hidden />
          </Link>
        </>
      ) : (
        "."
      )}
    </p>
  )
}
