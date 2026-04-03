import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/Switch"
import { TextField } from "@/components/ui/TextField"
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

export function ConnectorSetupDialog({
  orgSlug,
  isOpen,
  onOpenChange,
}: ConnectorSetupDialogProps) {
  const [waitForInstall, setWaitForInstall] = useState(false)
  const [repositoryName, setRepositoryName] = useState("")
  const [branch, setBranch] = useState("main")
  const [enabled, setEnabled] = useState(true)
  const [targetInitialized, setTargetInitialized] = useState(false)
  const installUrl = getInstallUrl()

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
    }
  }, [status?.isInstalled])

  useEffect(() => {
    if (targetInitialized || !config?.syncTarget) return
    setRepositoryName(config.syncTarget.repositoryName)
    setBranch(config.syncTarget.branch)
    setEnabled(config.syncTarget.enabled)
    setTargetInitialized(true)
  }, [config?.syncTarget, targetInitialized])

  const setupSteps = useMemo<SetupStep[]>(() => {
    const steps: SetupStep[] = [
      { id: "link", label: "Link Atlassian account" },
      { id: "install", label: "Open Forge app install" },
      { id: "wait", label: "Wait for installation event" },
    ]
    if (!status?.isGithubLinked) {
      steps.push({ id: "github", label: "Ensure GitHub is linked" })
    }
    steps.push({ id: "target", label: "Configure sync target" })
    return steps
  }, [status?.isGithubLinked])

  const completedSteps = useMemo(() => {
    const completed = new Set<SetupStep["id"]>()
    if (status?.isLinked) completed.add("link")
    if (status?.isInstalled) {
      completed.add("install")
      completed.add("wait")
    } else if (waitForInstall) {
      completed.add("install")
    }
    if (status?.isGithubLinked) {
      completed.add("github")
    }
    if (status?.syncTargetConfigured) {
      completed.add("target")
    }
    return completed
  }, [
    status?.isLinked,
    status?.isInstalled,
    status?.isGithubLinked,
    status?.syncTargetConfigured,
    waitForInstall,
  ])

  const currentStep: SetupStep["id"] = useMemo(() => {
    if (!status?.isLinked) return "link"
    if (!status?.isInstalled) return waitForInstall ? "wait" : "install"
    if (!status?.isGithubLinked) return "github"
    if (!status?.syncTargetConfigured) return "target"
    return "target"
  }, [
    status?.isLinked,
    status?.isInstalled,
    status?.isGithubLinked,
    status?.syncTargetConfigured,
    waitForInstall,
  ])

  const saveTargetMutation = useMutation({
    mutationFn: async () => {
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
            repositoryName: repositoryName.trim(),
            branch: branch.trim(),
            enabled,
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
      <div className="w-full max-w-[min(90vw,920px)] rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
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
          completedSteps={completedSteps}
        />

        {statusPending ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-zinc-300">
            <Spinner className="text-zinc-400" />
            Loading connector status...
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <section className="rounded-lg border border-zinc-800 p-4">
              <h3 className="text-sm font-semibold">
                1. Link Atlassian account
              </h3>
              <p className="mt-1 text-sm text-zinc-400">
                First connect your Atlassian account for this organization.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
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
            </section>

            <section className="rounded-lg border border-zinc-800 p-4">
              <h3 className="text-sm font-semibold">2. Install Forge app</h3>
              <p className="mt-1 text-sm text-zinc-400">
                Open Atlassian install in a popup, then we will wait for backend
                lifecycle event.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  isPending={installIntentMutation.isPending}
                  isDisabled={!installUrl || !status?.isLinked}
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
                <p className="mt-2 text-sm text-red-400">
                  {installIntentMutation.error.message}
                </p>
              ) : null}
            </section>

            {waitForInstall && !status?.isInstalled ? (
              <section className="rounded-lg border border-zinc-800 p-4">
                <h3 className="text-sm font-semibold">
                  3. Waiting for installation event
                </h3>
                <p className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
                  <Spinner className="text-zinc-400" />
                  Waiting for Forge lifecycle webhook...
                </p>
              </section>
            ) : null}

            {status?.isInstalled ? (
              <section className="rounded-lg border border-zinc-800 p-4">
                <h3 className="text-sm font-semibold">Connector installed</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  The Atlassian connector is now active for this organization.
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="secondary"
                    onPress={() => void refetchStatus()}
                  >
                    Refresh status
                  </Button>
                </div>
              </section>
            ) : null}

            {status?.isInstalled && !status?.isGithubLinked ? (
              <section className="rounded-lg border border-zinc-800 p-4">
                <h3 className="text-sm font-semibold">
                  4. Ensure GitHub is linked
                </h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Confluence ingestion sync uses your organization GitHub App
                  installation. Connect GitHub to finish setup.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onPress={() => {
                      window.location.href = `/${orgSlug}/repositories`
                    }}
                  >
                    Connect GitHub
                  </Button>
                </div>
              </section>
            ) : null}

            {status?.isInstalled && status?.isGithubLinked ? (
              <section className="rounded-lg border border-zinc-800 p-4">
                <h3 className="text-sm font-semibold">5. Configure sync target</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Choose where Confluence content syncs in your GitHub repository.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <TextField
                    label="Repository"
                    value={repositoryName}
                    onChange={setRepositoryName}
                    placeholder="owner/repository"
                    isRequired
                  />
                  <TextField
                    label="Branch"
                    value={branch}
                    onChange={setBranch}
                    placeholder="main"
                    isRequired
                  />
                </div>
                <div className="mt-4">
                  <Switch isSelected={enabled} onChange={setEnabled}>
                    Enable automatic sync
                  </Switch>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="secondary"
                    isPending={saveTargetMutation.isPending}
                    isDisabled={!repositoryName.trim() || !branch.trim()}
                    onPress={() => {
                      void saveTargetMutation.mutateAsync()
                    }}
                  >
                    Save sync target
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
