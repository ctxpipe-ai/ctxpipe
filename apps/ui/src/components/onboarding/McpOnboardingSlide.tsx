import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { client } from "@/lib/api"
import {
  buildOrMergeCursorClaudeMcpJson,
  buildOrMergeOpenCodeMcpJson,
  mcpStreamUrlForOrg,
  pathsForAgent,
} from "@/lib/mcpOnboardingPreview"

type McpAgentId = "cursor" | "claude_code" | "opencode"

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

export function McpOnboardingSlide(props: {
  orgSlug: string | null
  hasGithubInstallation: boolean
  mcpSnippet: string
  mcpCopyState: "idle" | "copied" | "error"
  onCopySnippet: () => void
  onContinue: () => void
  onSkip: () => void
}) {
  const { orgSlug, hasGithubInstallation } = props
  const [mode, setMode] = useState<"choose" | "manual" | "auto">("choose")
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

  useEffect(() => {
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
  }, [setupData, repoPage])

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

  const previewBlocks = useMemo(() => {
    const blocks: { path: string; content: string }[] = []
    const seen = new Set<string>()
    for (const agent of agents) {
      for (const path of pathsForAgent(agent)) {
        if (seen.has(path)) continue
        seen.add(path)
        const existing =
          path === "opencode.json"
            ? null
            : path === ".cursor/mcp.json" || path === ".mcp.json"
              ? null
              : null
        const content =
          agent === "opencode"
            ? buildOrMergeOpenCodeMcpJson(existing, mcpUrl)
            : buildOrMergeCursorClaudeMcpJson(existing, mcpUrl)
        blocks.push({ path, content })
      }
    }
    return blocks
  }, [agents, mcpUrl])

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

  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Connect ctx| to your agents
      </h2>

      {mode === "choose" && (
        <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
          <p className="mx-auto mb-8 max-w-2xl text-balance text-zinc-300">
            Add the ctx| MCP server manually with a JSON snippet, or open pull
            requests that drop the right config files into repositories you
            already connected on GitHub.
          </p>
          <div className="mx-auto grid max-w-2xl gap-4 sm:grid-cols-2">
            <button
              type="button"
              className="rounded-none border border-border bg-zinc-950/70 p-6 text-left transition-colors hover:border-teal-400/40"
              onClick={() => setMode("manual")}
            >
              <span className="block text-lg font-medium text-zinc-100">
                Install manually
              </span>
              <span className="mt-2 block text-sm text-zinc-400">
                Copy a ready-made MCP config for Cursor, Claude Code, or other
                HTTP MCP clients.
              </span>
            </button>
            <button
              type="button"
              disabled={!hasGithubInstallation}
              className={`rounded-none border border-border p-6 text-left transition-colors ${
                hasGithubInstallation
                  ? "bg-zinc-950/70 hover:border-teal-400/40"
                  : "cursor-not-allowed bg-zinc-950/40 opacity-60"
              }`}
              onClick={() => hasGithubInstallation && setMode("auto")}
            >
              <span className="block text-lg font-medium text-zinc-100">
                Open PRs for me
              </span>
              <span className="mt-2 block text-sm text-zinc-400">
                {hasGithubInstallation
                  ? "Pick agents and repos; we commit config files and open one PR per repository."
                  : "Connect GitHub in the previous step (or from repository settings) to use automatic PRs."}
              </span>
            </button>
          </div>
          <div className="mt-10 flex flex-col items-center gap-6">
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => props.onSkip()}
            >
              I&apos;ll do this later
            </button>
          </div>
        </div>
      )}

      {mode === "manual" && (
        <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
          <p className="mx-auto mb-6 max-w-2xl text-balance text-zinc-300">
            Paste this into your MCP client configuration. The URL targets this
            deployment and includes your organisation slug.
          </p>
          <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-4 text-left">
            <pre className="overflow-x-auto text-sm leading-6 text-zinc-100">
              <code>{props.mcpSnippet}</code>
            </pre>
          </div>
          <div className="mt-6 flex flex-col items-center gap-6">
            <button
              type="button"
              className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
              onClick={() => void props.onCopySnippet()}
            >
              {props.mcpCopyState === "copied"
                ? "Copied"
                : props.mcpCopyState === "error"
                  ? "Copy failed"
                  : "Copy JSON"}
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => props.onContinue()}
            >
              Continue
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => setMode("choose")}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {mode === "auto" && (
        <div className="onb-in-2 mx-auto mb-10 max-w-3xl text-left">
          <p className="mx-auto mb-6 max-w-2xl text-balance text-center text-zinc-300">
            Choose which agent ecosystems need on-disk config, then narrow
            repositories if you do not want a PR on every connected repo.
          </p>

          <div className="mb-8 rounded-none border border-border bg-zinc-950/70 p-5">
            <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
              Agents
            </h3>
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

          <div className="mb-8 rounded-none border border-border bg-zinc-950/70 p-5">
            <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
              Repositories
            </h3>
            {!repoPage?.repositories?.length ? (
              <p className="text-sm text-zinc-500">
                No repositories returned for this installation yet. Finish
                GitHub repository setup, then return here.
              </p>
            ) : (
              <ul className="max-h-48 space-y-2 overflow-y-auto pr-1 text-sm">
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

          <div className="mb-8 rounded-none border border-border bg-zinc-950/70 p-5">
            <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
              Proposed changes
            </h3>
            <p className="mb-4 text-xs text-zinc-500">
              Remote MCP URL used in generated files:{" "}
              <span className="break-all font-mono text-zinc-400">
                {mcpUrl}
              </span>
            </p>
            <p className="mb-4 text-xs text-zinc-600">
              If a file already exists on your default branch, the PR merges the
              ctxpipe entry into existing JSON instead of replacing the whole
              file.
            </p>
            <div className="space-y-4">
              {previewBlocks.map((b) => (
                <div key={b.path}>
                  <div className="mb-1 font-mono text-xs text-teal-400/90">
                    {b.path}
                  </div>
                  <pre className="max-h-40 overflow-auto rounded-none border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
                    {b.content.trimEnd()}
                  </pre>
                </div>
              ))}
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
            <button
              type="button"
              disabled={
                createPrsMutation.isPending ||
                agents.size === 0 ||
                selectedRepoFullNames.size === 0
              }
              className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void createPrsMutation.mutateAsync()}
            >
              {createPrsMutation.isPending
                ? "Opening PRs…"
                : "Raise pull requests"}
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => props.onContinue()}
            >
              Continue
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => {
                setPrLinks(null)
                setPrError(null)
                setMode("choose")
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </>
  )
}
