import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { SuccessIcon } from "@/components/ui/SuccessIcon"
import { authClient } from "@/lib/auth-client"
import { client } from "@/lib/api"
import type {
  AtlassianConnectorConfig,
  AtlassianConnectorStatus,
} from "../types"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ConnectorSetupSteps, type SetupStep } from "./ConnectorSetupSteps"

// GitHub repo item type for ComboBox
type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

type ConnectorSetupDialogProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

const prodInstallUrl =
  "https://developer.atlassian.com/console/install/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43?signature=AYABeHVDAf5aXCIrGwJnqpdOVGkAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4IOp8r3eKNYw8z2v%2FEq3%2FfvrZguoGsXpNSaDveR%2FF%2Fo0BL97OtlgDVB%2F6bVzIoGlYnAAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDPnd5dDThFE2AeK3gwIBEIA7bpJ76B1JAQ5ste8jbpIW3UGhQ3QyKzQNWJC7SgSkKsOt6%2FUXBgOUaH%2F085gjoyt4fo8QZXQZbf8lVq0AB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHijmwVTMt6Oj3F%2B0%2B0cVrojrS8yZ9ktpdfDxqPMSIkvHAGqS%2Bu6Xkl1%2BVX9kyfu6eR2AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMdlRCDta0yCs%2BsAC%2FAgEQgDvGOHhdaoUFBCx0JzSQqcIr%2Ff5v2yEaB0adMNHGFxMriaazcie1wfO0JQAbqgf%2BvUMJfsgjBiJoLsxD0AAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeLKa7Dfn9BgbXaQmJGrkKztjV4vrreTkqr7wGwhqIYs5AQvglxckFYQ5SPJchEhcDMEAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAzK%2B2c50uF6UDneHKUCARCAO1lYpKAJ%2Bx5HsgNVmbbc5%2F94pM49qIz0vUDOxnNzKIoTYmIpnhmxJE%2FAS65yMvEUTjocoDRFHiuB4XxFAgAAAAAMAAAQAAAAAAAAAAAAAAAAADUly9kk8jQl8cQzOtGFfGv%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADKkVY2UWgKIEU9BWyBLwg54t5uX68N68OAr1vxzWpfrGaC9p1q7llHOJGjmFd%2FYwRW4de3J5v%2FDabrgqJ%2FC6BzpdOU%3D&product=confluence"
function getInstallUrl() {
  return prodInstallUrl
}

// View state for the wizard
type ViewState =
  | { type: "step"; stepId: "link" | "install" | "wait" | "github" | "target" }
  | { type: "success" }

export function ConnectorSetupDialog({
  orgSlug,
  isOpen,
  onOpenChange,
}: ConnectorSetupDialogProps) {
  const [waitForInstall, setWaitForInstall] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [hasShownSuccess, setHasShownSuccess] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [targetInitialized, setTargetInitialized] = useState(false)
  const installUrl = getInstallUrl()

  // Debounce repo search input
  useEffect(() => {
    const id = setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => clearTimeout(id)
  }, [repoSearch])

  const {
    data: status,
    isPending: statusPending,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: ["atlassian-connector-status", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.status.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch Atlassian connector status")
      return (await res.json()) as AtlassianConnectorStatus
    },
    enabled: isOpen,
    refetchInterval: (query) => {
      const data = query.state.data as AtlassianConnectorStatus | undefined
      if (!isOpen) return false
      if (!waitForInstall) return false
      return data?.isInstalled ? false : 3000
    },
  })

  const { data: config, refetch: refetchConfig } = useQuery({
    queryKey: ["atlassian-connector-config", orgSlug],
    queryFn: async () => {
      const res = await fetch(`/${orgSlug}/api/v1/connectors/atlassian/config`, {
        credentials: "include",
      })
      if (!res.ok) {
        if (res.status === 409) return null
        throw new Error("Failed to load connector config")
      }
      return (await res.json()) as AtlassianConnectorConfig
    },
    enabled: isOpen && Boolean(status?.isInstalled),
    throwOnError: false,
  })

  // Query to search GitHub repositories
  const { data: repoSearchResults, isLoading: isSearchingRepos } = useQuery({
    queryKey: ["github-repos-search", orgSlug, debouncedRepoSearch],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.repositories.$get as (arg: {
          param: { orgSlug: string }
          query: { q: string; per_page: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        query: { q: debouncedRepoSearch, per_page: "30" },
      })
      if (!res.ok) throw new Error("Failed to search repositories")
      return (await res.json()) as {
        repositories: GitHubRepoItem[]
        repositorySelection: string
        hasMore: boolean
      }
    },
    enabled: isOpen && Boolean(status?.isInstalled) && Boolean(debouncedRepoSearch.length > 0),
  })

  const installIntentMutation = useMutation({
    mutationFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.installation.$post as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
          error?: string
          why?: string
        }
        throw new Error(
          body.message ?? body.error ?? "Failed to register install intent",
        )
      }
      return res.json()
    },
    onSuccess: async () => {
      await refetchStatus()
    },
  })

  useEffect(() => {
    if (status?.isInstalled) {
      setWaitForInstall(false)
      // Show success state when installation completes (only once)
      if (!hasShownSuccess && !status?.syncTargetConfigured) {
        setShowSuccess(true)
        setHasShownSuccess(true)
      }
    }
  }, [status?.isInstalled, status?.syncTargetConfigured, hasShownSuccess])

  useEffect(() => {
    if (targetInitialized || !config?.syncTarget) return
    // Initialize selected repo from existing config
    setSelectedRepo({
      id: 0, // We don't have the ID from config, but that's OK
      full_name: config.syncTarget.repositoryName,
      html_url: `https://github.com/${config.syncTarget.repositoryName}`,
      clone_url: `https://github.com/${config.syncTarget.repositoryName}.git`,
      name: config.syncTarget.repositoryName.split("/").pop() ?? "",
      default_branch: config.syncTarget.branch,
    })
    setTargetInitialized(true)
  }, [config?.syncTarget, targetInitialized])

  const setupSteps = useMemo<SetupStep[]>(() => {
    const steps: SetupStep[] = [
      { id: "link", label: "Link Atlassian account" },
      { id: "install", label: "Install Forge app" },
      { id: "wait", label: "Wait for installation" },
    ]
    if (!status?.isGithubLinked) {
      steps.push({ id: "github", label: "Link GitHub account" })
    }
    steps.push({ id: "target", label: "Select target repository" })
    return steps
  }, [status?.isGithubLinked])

  const currentStep: SetupStep["id"] = useMemo(() => {
    if (!status?.isLinked) return "link"
    if (!status?.isInstalled) return waitForInstall ? "wait" : "install"
    if (!status?.isGithubLinked) return "github"
    return "target"
  }, [
    status?.isLinked,
    status?.isInstalled,
    status?.isGithubLinked,
    waitForInstall,
  ])

  // Determine the view state
  const viewState: ViewState = useMemo(() => {
    const isSuccessView = showSuccess && !status?.syncTargetConfigured
    if (isSuccessView) {
      return { type: "success" }
    }
    return { type: "step", stepId: currentStep }
  }, [showSuccess, status?.syncTargetConfigured, currentStep])

  const handleContinueFromSuccess = () => {
    setShowSuccess(false)
  }

  const saveTargetMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRepo) throw new Error("No repository selected")
      const spaces = config?.spaces.map((row) => ({
        spaceKey: row.spaceKey,
        spaceName: row.spaceName ?? undefined,
        selectedPageIds: row.selectedPageIds,
      })) ?? []
      const response = await fetch(`/${orgSlug}/api/v1/connectors/atlassian/config`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaces,
          syncTarget: {
            repositoryName: selectedRepo.full_name,
            branch: selectedRepo.default_branch,
            enabled: true, // Always enabled by default
          },
        }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(body.error ?? "Failed to save sync target")
      }
      return response.json() as Promise<{ accepted: true }>
    },
    onSuccess: async () => {
      toast.success("Sync target saved. Full sync has been queued.")
      await Promise.all([refetchStatus(), refetchConfig()])
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <div className="w-full max-w-[min(90vw,560px)] rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              Set up Atlassian connector
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Complete each step to connect Confluence content to this
              organization.
            </p>
          </div>
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            Close
          </Button>
        </div>

        <ConnectorSetupSteps
          steps={setupSteps}
          currentStep={currentStep}
          isInstalled={status?.isInstalled ?? false}
        />

        {statusPending ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-zinc-300">
            <Spinner className="text-zinc-400" />
            Loading connector status...
          </div>
        ) : (
          <div className="mt-8">
            {/* Success State */}
            {viewState.type === "success" && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="rounded-full bg-emerald-500/10 p-4">
                  <SuccessIcon className="size-12 text-emerald-500" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-zinc-100">
                  Connector installed successfully!
                </h3>
                <p className="mt-2 max-w-sm text-sm text-zinc-400">
                  The Atlassian connector is now active. Continue to select where your Confluence content will be synced.
                </p>
                <Button
                  className="mt-6"
                  variant="primary"
                  onPress={handleContinueFromSuccess}
                >
                  Continue
                </Button>
              </div>
            )}

            {/* Step: Link Atlassian */}
            {viewState.type === "step" && viewState.stepId === "link" && (
              <div className="rounded-lg border border-zinc-800 p-6">
                <h3 className="text-base font-semibold">
                  Link Atlassian account
                </h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Connect your Atlassian account to enable Confluence access for this organization.
                </p>
                <div className="mt-6">
                  <Button
                    variant="primary"
                    onPress={async () => {
                      await authClient.linkSocial({
                        provider: "atlassian",
                        callbackURL: window.location.pathname,
                      })
                    }}
                  >
                    Connect Atlassian account
                  </Button>
                </div>
              </div>
            )}

            {/* Step: Install Forge App */}
            {viewState.type === "step" && viewState.stepId === "install" && (
              <div className="rounded-lg border border-zinc-800 p-6">
                <h3 className="text-base font-semibold">Install Forge app</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Install the CtxPipe Forge app to your Confluence workspace. A popup will open for installation.
                </p>
                <div className="mt-6">
                  <Button
                    variant="primary"
                    isPending={installIntentMutation.isPending}
                    isDisabled={!installUrl}
                    onPress={async () => {
                      if (!installUrl) return
                      await installIntentMutation.mutateAsync()
                      window.open(
                        installUrl,
                        "ctxpipe-forge-install",
                        "width=860,height=740",
                      )
                      setWaitForInstall(true)
                      void refetchStatus()
                    }}
                  >
                    Install Forge app
                  </Button>
                </div>
                {installIntentMutation.error ? (
                  <p className="mt-4 text-sm text-red-400">
                    {installIntentMutation.error.message}
                  </p>
                ) : null}
              </div>
            )}

            {/* Step: Wait for Installation */}
            {viewState.type === "step" && viewState.stepId === "wait" && (
              <div className="rounded-lg border border-zinc-800 p-6">
                <h3 className="text-base font-semibold">Waiting for installation</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Waiting for the Forge app installation to complete. This usually takes a few moments.
                </p>
                <div className="mt-6 flex items-center gap-3">
                  <Spinner className="text-zinc-400" />
                  <span className="text-sm text-zinc-300">Waiting for installation confirmation...</span>
                </div>
              </div>
            )}

            {/* Step: Link GitHub */}
            {viewState.type === "step" && viewState.stepId === "github" && (
              <div className="rounded-lg border border-zinc-800 p-6">
                <h3 className="text-base font-semibold">Link GitHub account</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Confluence content syncs to a GitHub repository. Connect your GitHub account to continue.
                </p>
                <div className="mt-6">
                  <Button
                    variant="primary"
                    onPress={() => {
                      window.location.href = `/${orgSlug}/repositories`
                    }}
                  >
                    Connect GitHub
                  </Button>
                </div>
              </div>
            )}

            {/* Step: Select Target Repository */}
            {viewState.type === "step" && viewState.stepId === "target" && (
              <div className="rounded-lg border border-zinc-800 p-6">
                {console.log("[ConnectorSetup] Rendering target step", { selectedRepo, repoSearch, repoCount: repoSearchResults?.repositories.length })}
                <h3 className="text-base font-semibold">Select target repository for Confluence content</h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Choose the GitHub repository where Confluence content will be synced.
                </p>
                <div className="mt-6 space-y-4">
                  <ComboBox
                    label="Repository"
                    placeholder="Type to search repositories..."
                    inputValue={selectedRepo?.full_name ?? repoSearch}
                    onInputChange={(value) => {
                      setRepoSearch(value)
                      // Clear selection when user types
                      if (selectedRepo && value !== selectedRepo.full_name) {
                        setSelectedRepo(null)
                      }
                    }}
                    onSelectionChange={(key) => {
                      const repo = repoSearchResults?.repositories.find((r) => r.id.toString() === key)
                      if (repo) {
                        setSelectedRepo(repo)
                        setRepoSearch(repo.full_name)
                      }
                    }}
                    items={repoSearchResults?.repositories ?? []}
                  >
                    {(repo) => (
                      <ComboBoxItem id={repo.id.toString()} textValue={repo.full_name}>
                        {repo.full_name}
                      </ComboBoxItem>
                    )}
                  </ComboBox>

                  {/* Default branch - shown read-only when repo is selected */}
                  {selectedRepo && (
                    <div className="rounded-md bg-zinc-900/50 p-3">
                      <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Default branch</div>
                      <div className="mt-1 text-sm text-zinc-300">{selectedRepo.default_branch}</div>
                    </div>
                  )}

                  {isSearchingRepos && (
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Spinner className="size-4" />
                      Searching repositories...
                    </div>
                  )}

                  {!isSearchingRepos && debouncedRepoSearch.length > 0 && repoSearchResults?.repositories.length === 0 && (
                    <div className="text-sm text-zinc-500">
                      No repositories found. Try a different search.
                    </div>
                  )}

                  <div className="pt-2">
                    <Button
                      variant="primary"
                      isPending={saveTargetMutation.isPending}
                      isDisabled={!selectedRepo}
                      onPress={() => {
                        void saveTargetMutation.mutateAsync()
                      }}
                    >
                      Save sync target
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
