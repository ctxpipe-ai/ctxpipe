import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { authClient } from "@/lib/auth-client"
import { client } from "@/lib/api"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { ConnectorSetupSteps, type SetupStep } from "./ConnectorSetupSteps"

type ConnectorSetupDialogProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

type AtlassianStatus = {
  isLinked: boolean
  isInstalled: boolean
  installationStatus: string | null
  selectedPageCount: number
  linkedSite: {
    cloudId: string
    siteUrl: string
    siteName: string | null
  } | null
}

type ConfluenceSpace = {
  id: string
  key: string | null
  name: string
}

type ConfluencePage = {
  id: string
  title: string
}

const setupSteps: SetupStep[] = [
  { id: "link", label: "Link Atlassian account and site" },
  { id: "install", label: "Open Forge app install" },
  { id: "wait", label: "Wait for installation event" },
  { id: "select", label: "Select spaces and pages" },
]

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
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(
    new Set(),
  )
  const [pagesBySpace, setPagesBySpace] = useState<
    Record<string, ConfluencePage[]>
  >({})
  const [selectedPageIdsBySpace, setSelectedPageIdsBySpace] = useState<
    Record<string, Set<string>>
  >({})
  const [loadingSpaceIds, setLoadingSpaceIds] = useState<Set<string>>(new Set())
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
      return (await res.json()) as AtlassianStatus
    },
    enabled: isOpen,
    refetchInterval: (query) => {
      const data = query.state.data as AtlassianStatus | undefined
      if (!isOpen) return false
      if (!waitForInstall) return false
      return data?.isInstalled ? false : 3000
    },
  })

  const { data: spacesData, isPending: spacesPending } = useQuery({
    queryKey: ["atlassian-confluence-spaces", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.spaces.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch Confluence spaces")
      return (await res.json()) as { spaces: ConfluenceSpace[] }
    },
    enabled: isOpen && Boolean(status?.isInstalled),
  })

  const linkMutation = useMutation({
    mutationFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.link.$post as (arg: {
          param: { orgSlug: string }
          json: { cloudId?: string; siteUrl?: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        json: {},
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
          error?: string
          why?: string
        }
        throw new Error(
          body.message ?? body.error ?? "Failed to link Atlassian site",
        )
      }
      return res.json()
    },
    onSuccess: async () => {
      await refetchStatus()
    },
  })

  const saveSelectionMutation = useMutation({
    mutationFn: async () => {
      const spaceById = new Map(
        (spacesData?.spaces ?? []).map((space) => [space.id, space]),
      )
      const selections = Array.from(selectedSpaceIds).flatMap((spaceId) => {
        const pages = pagesBySpace[spaceId] ?? []
        const selectedPageIds =
          selectedPageIdsBySpace[spaceId] ?? new Set<string>()
        const space = spaceById.get(spaceId)
        return pages
          .filter((page) => selectedPageIds.has(page.id))
          .map((page) => ({
            spaceId,
            spaceKey: space?.key ?? undefined,
            spaceName: space?.name ?? undefined,
            pageId: page.id,
            pageTitle: page.title,
          }))
      })

      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.selection.$put as (arg: {
          param: { orgSlug: string }
          json: { selections: Array<Record<string, string>> }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        json: { selections },
      })
      if (!res.ok) {
        throw new Error("Failed to save Confluence selection")
      }
      return res.json()
    },
    onSuccess: async () => {
      await refetchStatus()
      onOpenChange(false)
    },
  })

  async function ensureSpacePagesLoaded(spaceId: string) {
    if (pagesBySpace[spaceId] || loadingSpaceIds.has(spaceId)) return
    setLoadingSpaceIds((prev) => new Set([...prev, spaceId]))
    try {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.spaces[":spaceId"].pages
          .$get as (arg: {
          param: { orgSlug: string; spaceId: string }
        }) => Promise<Response>
      )({
        param: { orgSlug, spaceId },
      })
      if (!res.ok) throw new Error("Failed to load space pages")
      const json = (await res.json()) as { pages: ConfluencePage[] }
      setPagesBySpace((prev) => ({ ...prev, [spaceId]: json.pages }))
      setSelectedPageIdsBySpace((prev) => ({
        ...prev,
        [spaceId]: new Set(json.pages.map((page) => page.id)),
      }))
    } finally {
      setLoadingSpaceIds((prev) => {
        const next = new Set(prev)
        next.delete(spaceId)
        return next
      })
    }
  }

  useEffect(() => {
    if (status?.isInstalled) {
      setWaitForInstall(false)
    }
  }, [status?.isInstalled])

  const completedSteps = useMemo(() => {
    const completed = new Set<SetupStep["id"]>()
    if (status?.isLinked) completed.add("link")
    if (status?.isInstalled) {
      completed.add("install")
      completed.add("wait")
    } else if (waitForInstall) {
      completed.add("install")
    }
    if ((status?.selectedPageCount ?? 0) > 0) completed.add("select")
    return completed
  }, [
    status?.isLinked,
    status?.isInstalled,
    status?.selectedPageCount,
    waitForInstall,
  ])

  const currentStep: SetupStep["id"] = useMemo(() => {
    if (!status?.isLinked) return "link"
    if (!status?.isInstalled) return waitForInstall ? "wait" : "install"
    return "select"
  }, [status?.isLinked, status?.isInstalled, waitForInstall])

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
                1. Link Atlassian account and site
              </h3>
              <p className="mt-1 text-sm text-zinc-400">
                First connect your Atlassian account. Then save the linked site
                to this org.
              </p>
              {status?.linkedSite ? (
                <p className="mt-2 text-sm text-emerald-300">
                  Linked:{" "}
                  {status.linkedSite.siteName ?? status.linkedSite.siteUrl}
                </p>
              ) : null}
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
                <Button
                  variant="primary"
                  isPending={linkMutation.isPending}
                  onPress={() => linkMutation.mutate()}
                >
                  Save linked site
                </Button>
              </div>
              {linkMutation.error ? (
                <p className="mt-2 text-sm text-red-400">
                  {linkMutation.error.message}
                </p>
              ) : null}
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
                  isDisabled={!installUrl}
                  onPress={() => {
                    if (!installUrl) return
                    window.open(
                      installUrl,
                      "ctxpipe-forge-install",
                      "width=860,height=740",
                    )
                  }}
                >
                  Install Forge app
                </Button>
                <Button
                  variant="primary"
                  isDisabled={!status?.isLinked}
                  onPress={() => {
                    setWaitForInstall(true)
                    void refetchStatus()
                  }}
                >
                  I have installed the app
                </Button>
              </div>
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
                <h3 className="text-sm font-semibold">
                  4. Select spaces and pages
                </h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Selecting a space loads pages and selects all pages by
                  default. You can unselect individual pages.
                </p>

                {spacesPending ? (
                  <p className="mt-3 text-sm text-zinc-300">
                    Loading spaces...
                  </p>
                ) : (
                  <div className="mt-3 max-h-80 space-y-3 overflow-auto rounded-md border border-zinc-900 p-3">
                    {(spacesData?.spaces ?? []).map((space) => {
                      const spaceSelected = selectedSpaceIds.has(space.id)
                      const pages = pagesBySpace[space.id] ?? []
                      const selectedPages =
                        selectedPageIdsBySpace[space.id] ?? new Set<string>()
                      return (
                        <div
                          key={space.id}
                          className="rounded-md border border-zinc-900 p-3"
                        >
                          <Checkbox
                            isSelected={spaceSelected}
                            onChange={(next) => {
                              setSelectedSpaceIds((prev) => {
                                const updated = new Set(prev)
                                if (next) updated.add(space.id)
                                else updated.delete(space.id)
                                return updated
                              })
                              if (next) {
                                void ensureSpacePagesLoaded(space.id)
                              }
                            }}
                          >
                            <span className="font-medium">{space.name}</span>
                          </Checkbox>

                          {spaceSelected ? (
                            <div className="mt-2 pl-6">
                              {loadingSpaceIds.has(space.id) ? (
                                <p className="flex items-center gap-2 text-sm text-zinc-400">
                                  <Spinner className="text-zinc-500" />
                                  Loading pages...
                                </p>
                              ) : pages.length === 0 ? (
                                <p className="text-sm text-zinc-500">
                                  No pages found.
                                </p>
                              ) : (
                                <ul className="space-y-1">
                                  {pages.map((page) => (
                                    <li key={page.id}>
                                      <Checkbox
                                        isSelected={selectedPages.has(page.id)}
                                        onChange={(next) => {
                                          setSelectedPageIdsBySpace((prev) => {
                                            const current = new Set(
                                              prev[space.id] ?? [],
                                            )
                                            if (next) current.add(page.id)
                                            else current.delete(page.id)
                                            return {
                                              ...prev,
                                              [space.id]: current,
                                            }
                                          })
                                        }}
                                      >
                                        <span className="text-sm text-zinc-300">
                                          {page.title}
                                        </span>
                                      </Checkbox>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="mt-4 flex gap-2">
                  <Button
                    variant="primary"
                    isPending={saveSelectionMutation.isPending}
                    onPress={() => saveSelectionMutation.mutate()}
                    isDisabled={!status?.isInstalled}
                  >
                    Save selection
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => void refetchStatus()}
                  >
                    Refresh status
                  </Button>
                </div>
                {saveSelectionMutation.error ? (
                  <p className="mt-2 text-sm text-red-400">
                    {saveSelectionMutation.error.message}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
