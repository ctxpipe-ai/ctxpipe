import { useMutation, useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { McpConfigPreviewDiff } from "@/components/onboarding/McpConfigPreviewDiff"
import { Button } from "@/components/ui/Button"
import { client } from "@/lib/api"
import { mcpStreamUrlForOrg } from "@/lib/mcpOnboardingPreview"
import { cn } from "@/lib/utils"

type McpAgentId = "cursor" | "claude_code" | "opencode"

type WizardSection = "agents" | "repos" | "changes"

type McpPreviewFileRow = {
  repository: string
  path: string
  exists: boolean
  existingUtf8: string | null
  mergedUtf8: string
}

const AGENT_OPTIONS: { id: McpAgentId; label: string; hint: string }[] = [
  { id: "cursor", label: "Cursor", hint: ".cursor/mcp.json" },
  { id: "claude_code", label: "Claude Code", hint: ".mcp.json" },
  { id: "opencode", label: "OpenCode", hint: "opencode.json" },
]

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

type SetupRepo = { name: string; gitUrl: string }

function getPublicAppOrigin(): string {
  const api = import.meta.env.VITE_PUBLIC_API_URL
  if (api) {
    try {
      return new URL(api).origin
    } catch {
      /* ignore */
    }
  }
  return "https://app.ctxpipe.ai"
}

export type McpConfigPrWizardProps = {
  orgSlug: string | null
  hasGithubInstallation: boolean
  /** When set, pre-selects these `owner/repo` rows (e.g. already-ingested GitHub repos). */
  initialSelectedRepoFullNames?: readonly string[]
  /** Override max height for the repository checklist (e.g. `max-h-64` in a modal). */
  repoListMaxHeightClass?: string
  variant: "onboarding" | "standalone"
  /** Onboarding only: after PRs or when skipping PR step */
  onContinue?: () => void
  /** Onboarding only: return to the manual/auto choice step */
  onBackToModeChoice?: () => void
  /** Standalone (e.g. modal): dismiss — shows a Cancel button left of the main CTA */
  onCancel?: () => void
}

export function McpConfigPrWizard(props: McpConfigPrWizardProps) {
  const {
    orgSlug,
    hasGithubInstallation,
    initialSelectedRepoFullNames,
    repoListMaxHeightClass = "max-h-48",
    variant,
    onContinue,
    onBackToModeChoice,
    onCancel,
  } = props

  const [agents, setAgents] = useState<Set<McpAgentId>>(
    () => new Set<McpAgentId>(["cursor"]),
  )
  const [selectedRepoFullNames, setSelectedRepoFullNames] = useState<
    Set<string>
  >(new Set())
  const [prLinks, setPrLinks] = useState<
    { repository: string; pullRequestUrl: string }[] | null
  >(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [openSection, setOpenSection] = useState<WizardSection>("agents")
  /** Step 1 is open by default; user must open 2 and 3 at least once so "Raise PRs" is not mistaken for Next. */
  const [visitedSections, setVisitedSections] = useState<Set<WizardSection>>(
    () => new Set<WizardSection>(["agents"]),
  )

  const mcpUrl = useMemo(
    () => mcpStreamUrlForOrg(getPublicAppOrigin(), orgSlug ?? "your-org"),
    [orgSlug],
  )

  const { data: setupData } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      if (!orgSlug) return null
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to load GitHub setup")
      return (await res.json()) as {
        ingestAllRepositories: boolean
        includeFutureRepos: boolean
        savedRepositories: SetupRepo[]
      }
    },
    enabled: Boolean(orgSlug) && hasGithubInstallation,
  })

  const { data: repoPage } = useQuery({
    queryKey: ["github-installation-repos-onboarding", orgSlug],
    queryFn: async () => {
      if (!orgSlug) return null
      const res = await (
        client[":orgSlug"].api.v1.github.installation.repositories
          .$get as (arg: {
          param: { orgSlug: string }
          query: { page: string; per_page: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        query: { page: "1", per_page: "100" },
      })
      if (!res.ok) throw new Error("Failed to list repositories")
      return (await res.json()) as {
        repositories: GitHubRepoItem[]
        hasMore: boolean
      }
    },
    enabled: Boolean(orgSlug) && hasGithubInstallation,
  })

  const initialKey = initialSelectedRepoFullNames?.join("\0") ?? ""

  useEffect(() => {
    if (!initialKey) return
    setSelectedRepoFullNames(new Set(initialSelectedRepoFullNames))
  }, [initialKey, initialSelectedRepoFullNames])

  useEffect(() => {
    if (initialKey) return
    if (
      !setupData?.savedRepositories?.length ||
      !repoPage?.repositories?.length
    ) {
      return
    }
    const byUrl = new Map(
      repoPage.repositories.map((r) => [r.clone_url, r.full_name]),
    )
    const next = new Set<string>()
    for (const saved of setupData.savedRepositories) {
      const full = byUrl.get(saved.gitUrl)
      if (full) next.add(full)
    }
    if (next.size > 0) {
      setSelectedRepoFullNames(next)
    }
  }, [initialKey, setupData, repoPage])

  const sortedRepoList = useMemo(
    () => [...selectedRepoFullNames].sort(),
    [selectedRepoFullNames],
  )
  const sortedAgentList = useMemo(
    () => [...agents].sort() as McpAgentId[],
    [agents],
  )

  /** User must open the repos and changes accordions at least once (step 1 is open by default). */
  const hasOpenedReposAndChanges = useMemo(
    () => visitedSections.has("repos") && visitedSections.has("changes"),
    [visitedSections],
  )

  const canRaisePullRequests =
    hasOpenedReposAndChanges &&
    agents.size > 0 &&
    selectedRepoFullNames.size > 0

  const previewQuery = useQuery({
    queryKey: [
      "mcp-config-preview",
      orgSlug,
      sortedRepoList.join("\0"),
      sortedAgentList.join("\0"),
    ],
    queryFn: async (): Promise<{ files: McpPreviewFileRow[] }> => {
      if (!orgSlug) throw new Error("Missing organisation")
      const res = await fetch(
        `/${encodeURIComponent(orgSlug)}/api/v1/github/installation/mcp-config-preview`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repositories: sortedRepoList,
            agents: sortedAgentList,
          }),
        },
      )
      const json = (await res.json()) as {
        files?: McpPreviewFileRow[]
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load MCP config preview")
      }
      return { files: json.files ?? [] }
    },
    enabled:
      Boolean(orgSlug) &&
      hasGithubInstallation &&
      sortedRepoList.length > 0 &&
      sortedAgentList.length > 0,
  })

  const filesByRepo = useMemo(() => {
    const files = previewQuery.data?.files ?? []
    const m = new Map<string, McpPreviewFileRow[]>()
    for (const f of files) {
      const list = m.get(f.repository) ?? []
      list.push(f)
      m.set(f.repository, list)
    }
    return m
  }, [previewQuery.data?.files])

  const toggleAgent = (id: McpAgentId) => {
    setAgents((prev) => {
      const n = new Set(prev)
      if (n.has(id)) {
        if (n.size === 1) return n
        n.delete(id)
      } else {
        n.add(id)
      }
      return n
    })
  }

  const toggleRepo = (fullName: string) => {
    setSelectedRepoFullNames((prev) => {
      const n = new Set(prev)
      if (n.has(fullName)) n.delete(fullName)
      else n.add(fullName)
      return n
    })
  }

  const createPrsMutation = useMutation({
    mutationFn: async () => {
      if (!orgSlug) throw new Error("Missing organisation")
      const repos = [...selectedRepoFullNames]
      if (repos.length === 0) throw new Error("Select at least one repository")
      const agentList = [...agents]
      const res = await fetch(
        `/${encodeURIComponent(orgSlug)}/api/v1/github/installation/mcp-config-prs`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repositories: repos,
            agents: agentList,
          }),
        },
      )
      const json = (await res.json()) as {
        pullRequests?: { repository: string; pullRequestUrl: string }[]
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to open pull requests")
      }
      return json.pullRequests ?? []
    },
    onSuccess: (data) => {
      setPrError(null)
      setPrLinks(data)
    },
    onError: (e: Error) => {
      setPrLinks(null)
      setPrError(e.message)
    },
  })

  const intro =
    variant === "onboarding" ? (
      <p className="mx-auto mb-6 max-w-2xl text-balance text-center text-zinc-300">
        Work through each step: pick agents, pick repositories, then review what
        would change on each default branch before you raise PRs.
      </p>
    ) : (
      <p className="mb-6 text-sm leading-relaxed text-zinc-400">
        Pick agent config files, choose GitHub repositories, preview merged JSON
        on each default branch, then open one pull request per repository.
      </p>
    )

  return (
    <div
      className={
        variant === "onboarding"
          ? "onb-in-2 mx-auto mb-10 max-w-3xl text-left"
          : "text-left"
      }
    >
      {intro}

      <div className="mb-4 flex flex-col gap-3">
        <div className="rounded-none border border-border bg-zinc-950/70">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-zinc-900/40"
            onClick={() => {
              setOpenSection("agents")
              setVisitedSections((prev) => new Set(prev).add("agents"))
            }}
          >
            <span className="text-sm font-medium uppercase tracking-wide text-zinc-400">
              1. Choose your agents
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-500 transition-transform",
                openSection === "agents" && "rotate-180",
              )}
            />
          </button>
          {openSection === "agents" && (
            <div className="border-t border-border px-5 pb-5 pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {AGENT_OPTIONS.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-start gap-2 text-sm text-zinc-200"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-border accent-teal-500"
                      checked={agents.has(a.id)}
                      onChange={() => toggleAgent(a.id)}
                    />
                    <span>
                      <span className="font-medium">{a.label}</span>
                      <span className="block text-xs text-zinc-500">
                        {a.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-none border border-border bg-zinc-950/70">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-zinc-900/40"
            onClick={() => {
              setOpenSection("repos")
              setVisitedSections((prev) => new Set(prev).add("repos"))
            }}
          >
            <span className="text-sm font-medium uppercase tracking-wide text-zinc-400">
              2. Choose repositories
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-500 transition-transform",
                openSection === "repos" && "rotate-180",
              )}
            />
          </button>
          {openSection === "repos" && (
            <div className="border-t border-border px-5 pb-5 pt-5">
              {!repoPage?.repositories?.length ? (
                <p className="text-sm text-zinc-500">
                  No repositories returned for this installation yet. Finish
                  GitHub repository setup, then return here.
                </p>
              ) : (
                <ul
                  className={`space-y-2 overflow-y-auto pr-1 text-sm ${repoListMaxHeightClass}`}
                >
                  {repoPage.repositories.map((r) => (
                    <li key={r.id}>
                      <label className="flex cursor-pointer items-center gap-2 text-zinc-200">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border accent-teal-500"
                          checked={selectedRepoFullNames.has(r.full_name)}
                          onChange={() => toggleRepo(r.full_name)}
                        />
                        <span className="font-mono text-xs">{r.full_name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="rounded-none border border-border bg-zinc-950/70">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-zinc-900/40"
            onClick={() => {
              setOpenSection("changes")
              setVisitedSections((prev) => new Set(prev).add("changes"))
            }}
          >
            <span className="text-sm font-medium uppercase tracking-wide text-zinc-400">
              3. Show changes
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-500 transition-transform",
                openSection === "changes" && "rotate-180",
              )}
            />
          </button>
          {openSection === "changes" && (
            <div className="border-t border-border px-5 pb-5 pt-5">
              <p className="mb-3 text-xs text-zinc-500">
                Remote MCP URL used in generated files:{" "}
                <span className="break-all font-mono text-zinc-400">
                  {mcpUrl}
                </span>
              </p>
              <p className="mb-4 text-xs text-zinc-600">
                We read each path on your default branch. If the file exists,
                the PR merges the ctxpipe entry into existing JSON; otherwise it
                adds a new file.
              </p>
              {sortedRepoList.length === 0 || sortedAgentList.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  Select at least one agent and one repository to load a preview
                  from GitHub.
                </p>
              ) : previewQuery.isPending ? (
                <p className="text-sm text-zinc-500">
                  Loading preview from GitHub…
                </p>
              ) : previewQuery.isError ? (
                <p className="text-sm text-red-400">
                  {previewQuery.error.message}
                </p>
              ) : (
                <div className="space-y-6">
                  {sortedRepoList.map((repo) => {
                    const rows = filesByRepo.get(repo) ?? []
                    return (
                      <div key={repo}>
                        <div className="mb-2 font-mono text-xs font-medium text-zinc-300">
                          {repo}
                        </div>
                        <div className="space-y-4 border-l border-zinc-800 pl-3">
                          {rows.map((file) => (
                            <div key={`${repo}:${file.path}`}>
                              <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-xs text-teal-400/90">
                                <span>{file.path}</span>
                                {file.exists ? (
                                  <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                                    Existing file
                                  </span>
                                ) : (
                                  <span className="rounded border border-teal-500/40 bg-teal-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-teal-300/90">
                                    New file
                                  </span>
                                )}
                              </div>
                              {file.exists ? (
                                <>
                                  <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                                    Diff (default branch → after merge)
                                  </p>
                                  <McpConfigPreviewDiff
                                    before={file.existingUtf8 ?? ""}
                                    after={file.mergedUtf8}
                                  />
                                </>
                              ) : (
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-none border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
                                  {file.mergedUtf8.trimEnd()}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {prError && (
        <p className="mb-4 text-center text-xs text-red-400">{prError}</p>
      )}

      {prLinks && prLinks.length > 0 && (
        <div className="mb-6 rounded-none border border-teal-400/30 bg-teal-400/5 p-4 text-sm text-teal-100">
          <p className="mb-2 font-medium">Pull requests opened</p>
          <ul className="space-y-2">
            {prLinks.map((p) => (
              <li key={p.repository}>
                <a
                  href={p.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-teal-300 underline underline-offset-2 hover:text-teal-200"
                >
                  {p.repository}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col items-center gap-4">
        <div
          className={
            onCancel
              ? "flex flex-wrap items-center justify-center gap-3"
              : "flex flex-col items-center"
          }
        >
          {onCancel ? (
            <Button
              type="button"
              variant="secondary"
              isDisabled={createPrsMutation.isPending}
              onPress={onCancel}
              className="rounded-none"
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            isDisabled={createPrsMutation.isPending || !canRaisePullRequests}
            isPending={createPrsMutation.isPending}
            onPress={() => void createPrsMutation.mutateAsync()}
            className="rounded-none"
          >
            Raise pull requests
          </Button>
        </div>
        {!hasOpenedReposAndChanges ? (
          <p className="max-w-md text-center text-xs text-zinc-500">
            Review all steps before raising the pull requests.
          </p>
        ) : null}
        {hasOpenedReposAndChanges && selectedRepoFullNames.size > 1 ? (
          <p className="max-w-md text-center text-xs text-zinc-500">
            Opening several pull requests can take a little while while we talk
            to GitHub for each repository.
          </p>
        ) : null}
        {variant === "onboarding" && onContinue ? (
          <button
            type="button"
            className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
            onClick={() => onContinue()}
          >
            Continue
          </button>
        ) : null}
        {variant === "onboarding" && onBackToModeChoice ? (
          <button
            type="button"
            className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
            onClick={() => {
              setPrLinks(null)
              setPrError(null)
              onBackToModeChoice()
            }}
          >
            Back
          </button>
        ) : null}
      </div>
    </div>
  )
}
