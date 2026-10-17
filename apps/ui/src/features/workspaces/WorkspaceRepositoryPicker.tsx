import { IconBrandGithub, IconExternalLink } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useMemo, useState } from "react"
import { TextField as AriaTextField, Link } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { FieldGroup, Input, Label } from "@/components/ui/Field"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/Tabs"
import { githubInstallationOptions } from "@/features/connectors/queries/github-connector"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  GithubRepoPickerList,
  GithubRepoPickerSkeleton,
} from "@/features/repositories/components/GithubRepoPickerList"
import { GithubRepoSortSelect } from "@/features/repositories/components/GithubRepoSortSelect"
import {
  type GithubRepoItem,
  type GithubRepoSort,
  githubInstallationReposOptions,
  sortGithubRepos,
} from "@/features/repositories/githubRepoSelection"
import { gitSourceMatchesQuery } from "@/features/repositories/gitSourcesFilter"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { githubGrantAccessUrls } from "@/lib/github-app-url"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import { eligibleInstallationRepos } from "./gitUrl"
import { fetchWorkspaces, workspaceKeys } from "./queries"
import { normalizeRootFolder, rootFolderError } from "./rootFolder"
import { WorkspaceRootFolderField } from "./WorkspaceRootFolderField"

export type WorkspaceRepositoryChoice = {
  gitUrl: string
  githubConnectionId?: string
  source: "select" | "paste"
  /** Normalized root folder; "" is the whole repository. */
  rootPath: string
}

type Mode = "select" | "create" | "paste"

export function WorkspaceRepositoryPicker(props: {
  orgSlug: string
  currentUrl?: string
  currentRootPath?: string
  submitLabel: string
  pending?: boolean
  error?: string | null
  onSubmit: (choice: WorkspaceRepositoryChoice) => void
}) {
  const { orgSlug, currentUrl, submitLabel, pending, error, onSubmit } = props
  const [mode, setMode] = useState<Mode>("select")
  const [gitUrl, setGitUrl] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [sort, setSort] = useState<GithubRepoSort>("pushed-desc")
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [rootFolder, setRootFolder] = useState(props.currentRootPath ?? "")
  const rootFolderValid = rootFolderError(rootFolder) === null
  const rootPath = normalizeRootFolder(rootFolder)

  const existing = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const takenUrls = (existing.data?.items ?? []).map(
    (item) => item.workspaceRepositoryUrl,
  )

  const connectionsQuery = useQuery(orgConnectionsOptions(orgSlug))
  const githubConnectionIds = (connectionsQuery.data ?? [])
    .filter((connection) => connection.type === "github")
    .map((connection) => connection.id)
  const noGithubConnection =
    connectionsQuery.isSuccess && githubConnectionIds.length === 0
  // Only an owner or admin can list the installation repositories.
  const isAdmin = useIsOrgAdmin(orgSlug)
  const reposQuery = useQuery({
    ...githubInstallationReposOptions(orgSlug, githubConnectionIds),
    enabled:
      connectionsQuery.isSuccess &&
      githubConnectionIds.length > 0 &&
      isAdmin === true,
    refetchOnWindowFocus: "always",
    // The user makes the repository on GitHub while this tab is open. A
    // failed read (for example a 403) stops the poll.
    refetchInterval: (query) =>
      mode === "create" && query.state.status !== "error" ? 4000 : false,
  })
  // The owner to prefill on GitHub, and the app to give access. With more
  // than one connection, the first one is a good default.
  const installationQuery = useQuery({
    ...githubInstallationOptions(orgSlug, githubConnectionIds[0]),
    enabled: githubConnectionIds.length > 0,
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
      sortGithubRepos(
        eligibleRepos.filter((repo) =>
          gitSourceMatchesQuery(repo.full_name, repo.clone_url, searchQuery),
        ),
        sort,
      ),
    [eligibleRepos, searchQuery, sort],
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
      <div className="mb-4">
        <WorkspaceRootFolderField
          value={rootFolder}
          onChange={setRootFolder}
          isDisabled={pending}
        />
      </div>
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
          className="m-0 rounded-md bg-zinc-800 p-1"
        >
          <Tab id="select">Select GitHub</Tab>
          <Tab id="create">Create on GitHub</Tab>
          <Tab id="paste">Paste URL</Tab>
        </TabList>
        <div className="relative overflow-hidden">
          <TabPanel id="select" className="p-0">
            <SelectGitHubPanel
              orgSlug={orgSlug}
              isAdmin={isAdmin}
              noGithubConnection={noGithubConnection}
              onPasteInstead={() => setMode("paste")}
              pending={pending}
              submitLabel={submitLabel}
              searchQuery={searchQuery}
              sort={sort}
              onSortChange={setSort}
              onSearchQueryChange={setSearchQuery}
              filteredRepos={filteredRepos}
              eligibleCount={eligibleRepos.length}
              selectedIds={selectedIds}
              selectedRepoUrl={selectedRepo?.clone_url ?? null}
              reposPending={connectionsQuery.isPending || reposQuery.isPending}
              reposFailed={connectionsQuery.isError || reposQuery.isError}
              onToggle={(id, selected) => {
                setSelectedId(selected ? id : null)
              }}
              onSubmit={(gitUrl, githubConnectionId) => {
                if (!githubConnectionId || !rootFolderValid) return
                onSubmit({
                  gitUrl,
                  githubConnectionId,
                  source: "select",
                  rootPath,
                })
              }}
              githubConnectionId={selectedRepo?.githubConnectionId}
              accessReady={accessReady}
              repositorySelection={repositorySelection}
              accessRepoCount={accessRepoCount}
              manageUrl={manageUrl}
            />
          </TabPanel>
          <TabPanel id="create" className="p-0">
            <CreateOnGithubSteps
              orgSlug={orgSlug}
              noGithubConnection={noGithubConnection}
              accountSlug={installationQuery.data?.accountSlug ?? null}
              repositorySelection={repositorySelection}
              grantAccessUrl={
                githubGrantAccessUrls({
                  appSlug: installationQuery.data?.appSlug,
                  manageUrl,
                })[0] ?? null
              }
              onSelect={() => {
                setMode("select")
                void reposQuery.refetch()
              }}
            />
          </TabPanel>
          <TabPanel id="paste" className="p-0">
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (gitUrl.trim() && rootFolderValid) {
                  onSubmit({ gitUrl: gitUrl.trim(), source: "paste", rootPath })
                }
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
                isDisabled={pending || !gitUrl.trim() || !rootFolderValid}
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
  orgSlug: string
  /** `null` while the role loads: the list skeleton shows. */
  isAdmin: boolean | null
  /** The org has no GitHub connection yet. */
  noGithubConnection: boolean
  onPasteInstead: () => void
  pending?: boolean
  submitLabel: string
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  sort: GithubRepoSort
  onSortChange: (sort: GithubRepoSort) => void
  filteredRepos: readonly GithubRepoItem[]
  eligibleCount: number
  selectedIds: Set<number>
  selectedRepoUrl: string | null
  reposPending: boolean
  reposFailed: boolean
  onToggle: (id: number, selected: boolean) => void
  onSubmit: (gitUrl: string, githubConnectionId?: string) => void
  githubConnectionId?: string
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

  if (props.isAdmin === false) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Ask an admin to pick a GitHub repository, or paste a git URL. Only an
          owner or admin can list the repositories of the GitHub App.
        </p>
        <Button variant="quiet" onPress={props.onPasteInstead}>
          Paste a git URL
        </Button>
      </div>
    )
  }

  if (props.noGithubConnection) {
    return (
      <ConnectGithubEmpty
        orgSlug={props.orgSlug}
        onPasteInstead={props.onPasteInstead}
      />
    )
  }

  if (props.reposPending) {
    return <GithubRepoPickerSkeleton />
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
          No repository is free to use. Give the GitHub App access to one more
          repository, or paste a git URL.
        </p>
        {accessLine}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <SearchField
          value={props.searchQuery}
          onChange={props.onSearchQueryChange}
          placeholder="Search repositories"
          aria-label="Search GitHub repositories"
          className="min-w-0 flex-1"
        />
        <GithubRepoSortSelect
          value={props.sort}
          onChange={props.onSortChange}
        />
      </div>
      {props.filteredRepos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repositories match.</p>
      ) : (
        <GithubRepoPickerList
          repos={props.filteredRepos}
          selectedIds={props.selectedIds}
          onToggle={props.onToggle}
          selectionMode="single"
          className="rounded-md border-border bg-zinc-900/40"
        />
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        {accessLine}
        {props.selectedRepoUrl ? (
          <Button
            variant="primary"
            className="ml-auto shrink-0"
            isDisabled={props.pending || !props.githubConnectionId}
            onPress={() => {
              if (props.selectedRepoUrl) {
                props.onSubmit(props.selectedRepoUrl, props.githubConnectionId)
              }
            }}
          >
            {props.submitLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The Select GitHub tab when the org has no GitHub connection. "Connect
 * GitHub" starts the same flow as the Connectors catalog. The hosted app
 * installs in a popup, so the dialog stays open and the list loads after.
 */
function ConnectGithubEmpty(props: {
  orgSlug: string
  onPasteInstead: () => void
}) {
  const connect = useConnectGithubInPlace(props.orgSlug)

  return (
    <div className="flex items-start gap-4 rounded-md border border-border bg-zinc-900/40 p-4">
      <span className="ctx-node size-10 shrink-0 rounded-md" aria-hidden>
        <IconBrandGithub className="size-5 text-foreground" />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">Connect GitHub</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect the GitHub App to pick a repository here. You stay in this
          dialog.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            isPending={connect.busy}
            onPress={connect.start}
          >
            Connect GitHub
          </Button>
          <Button variant="quiet" onPress={props.onPasteInstead}>
            Paste a git URL
          </Button>
        </div>
      </div>
      {connect.SelfHostedWizardModal}
    </div>
  )
}

/**
 * Start the GitHub connect flow of the Connectors catalog from this dialog.
 * When it ends, the connections reload, so the repository list follows.
 */
function useConnectGithubInPlace(orgSlug: string) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { start, isPending, isSyncing, SelfHostedWizardModal } =
    useGithubConnectFlow({
      orgSlug,
      onRegistered: () => {
        void queryClient.invalidateQueries({
          queryKey: orgConnectionsOptions(orgSlug).queryKey,
        })
      },
      onAlreadyInstalled: () => {
        void navigate({
          to: "/$orgSlug/github/setup",
          params: { orgSlug },
          search: { returnTo: "connectors" },
        })
      },
      onRegistrationFailed: (message) => toast.error(message),
    })
  return {
    start: () => start("connect"),
    busy: isPending || isSyncing,
    SelfHostedWizardModal,
  }
}

/**
 * The Create on GitHub tab. ctxpipe does not create the repository, so the
 * steps take the user through GitHub and back. A new repository shows in
 * the list only when the GitHub App can see it, so step 2 gives access (or
 * connects GitHub). The list reloads while this tab is open.
 */
function CreateOnGithubSteps(props: {
  orgSlug: string
  noGithubConnection: boolean
  accountSlug: string | null
  repositorySelection: string | undefined
  grantAccessUrl: string | null
  onSelect: () => void
}) {
  const connect = useConnectGithubInPlace(props.orgSlug)
  const params = new URLSearchParams({
    name: "ctxpipe-context",
    description: "ctxpipe Workspace knowledge",
  })
  if (props.accountSlug) params.set("owner", props.accountSlug)
  const linkClassName = `${focusVisibleClassName} inline-flex items-center gap-1 rounded-sm text-teal-400 hover:text-teal-300`
  const steps: { id: string; body: ReactNode }[] = [
    {
      id: "create",
      body: (
        <p>
          <Link
            href={`https://github.com/new?${params.toString()}`}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClassName}
          >
            Create the repository on GitHub
            <IconExternalLink className="size-3.5" aria-hidden />
          </Link>
          {props.accountSlug ? (
            <>
              {" "}
              under{" "}
              <code className="font-mono text-xs text-foreground">
                {props.accountSlug}
              </code>
            </>
          ) : null}
          . An empty repository is fine.
        </p>
      ),
    },
  ]
  if (props.noGithubConnection) {
    steps.push({
      id: "connect",
      body: (
        <div>
          <p>
            Connect GitHub. When GitHub asks which repositories ctxpipe can see,
            include the new one.
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            isPending={connect.busy}
            onPress={connect.start}
          >
            Connect GitHub
          </Button>
          {connect.SelfHostedWizardModal}
        </div>
      ),
    })
  } else if (props.repositorySelection === "selected" && props.grantAccessUrl) {
    steps.push({
      id: "access",
      body: (
        <p>
          <Link
            href={props.grantAccessUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClassName}
          >
            Give the ctxpipe GitHub App access
            <IconExternalLink className="size-3.5" aria-hidden />
          </Link>{" "}
          to the new repository. The app sees only the repositories you pick.
        </p>
      ),
    })
  }
  steps.push({
    id: "select",
    body: (
      <div>
        <p>Come back here and select the new repository.</p>
        <Button variant="secondary" className="mt-2" onPress={props.onSelect}>
          Select the repository
        </Button>
      </div>
    ),
  })

  return (
    <ol className="flex flex-col gap-4 text-sm text-muted-foreground">
      {steps.map((step, index) => (
        <li key={step.id} className="flex gap-3">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border font-mono text-xs text-foreground tabular-nums"
            aria-hidden
          >
            {index + 1}
          </span>
          <div className="min-w-0 pt-0.5">{step.body}</div>
        </li>
      ))}
    </ol>
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
