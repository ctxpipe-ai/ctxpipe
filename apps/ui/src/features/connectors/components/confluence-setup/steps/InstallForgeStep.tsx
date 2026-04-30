import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type FormEventHandler,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/Button"
import { Spinner } from "@/components/ui/spinner"
import { TextField } from "@/components/ui/TextField"
import { useConfluenceForgeRuntime } from "@/providers/ConfluenceForgeRuntimeContext"
import {
  atlassianConnectorKeys,
  fetchForgeProvisionStatus,
  fetchOrgCapabilities,
  postForgeProvision,
  registerAtlassianInstallIntent,
} from "../../../queries/atlassian-connector"
import { CONFLUENCE_FORGE_INSTALL_URL } from "../forge-install-url"

type InstallForgeStepProps = {
  orgSlug: string
  atlassianConnectionId: string
  onOpenedInstall: () => void
}

const PROVISION_POLL_MS = 2000
const PROVISION_TIMEOUT_MS = 15 * 60 * 1000

export function InstallForgeStep({
  orgSlug,
  atlassianConnectionId,
  onOpenedInstall,
}: InstallForgeStepProps) {
  const queryClient = useQueryClient()
  const forgeRuntime = useConfluenceForgeRuntime()

  const [confluenceSiteHost, setConfluenceSiteHost] = useState("")
  const [forgeScopedApiToken, setForgeScopedApiToken] = useState("")
  const [provisionFlowActive, setProvisionFlowActive] = useState(false)
  const [provisionTimedOut, setProvisionTimedOut] = useState(false)

  const advancedAfterProvisionRef = useRef(false)
  const provisionStartedAtRef = useRef<number | null>(null)

  const caps = useQuery({
    queryKey: atlassianConnectorKeys.capabilities(
      orgSlug,
      atlassianConnectionId,
    ),
    queryFn: () => fetchOrgCapabilities(orgSlug, atlassianConnectionId),
  })

  const installUrl = useMemo(() => {
    function pickHttps(candidate: string | null | undefined): string | null {
      const s = candidate?.trim()
      if (!s || !s.startsWith("https://")) return null
      return s
    }

    if (caps.isSuccess) {
      return pickHttps(caps.data.confluenceForgeInstallUrl)
    }
    return (
      pickHttps(forgeRuntime.installUrlFallback) ??
      pickHttps(CONFLUENCE_FORGE_INSTALL_URL)
    )
  }, [
    caps.isSuccess,
    caps.data?.confluenceForgeInstallUrl,
    forgeRuntime.installUrlFallback,
  ])

  const hasHostedInstall = Boolean(installUrl)

  const provisionStatusQuery = useQuery({
    queryKey: atlassianConnectorKeys.forgeProvisionStatus(
      orgSlug,
      atlassianConnectionId,
    ),
    queryFn: () => fetchForgeProvisionStatus(orgSlug, atlassianConnectionId),
    enabled: Boolean(atlassianConnectionId) && !hasHostedInstall,
    staleTime: 0,
    refetchInterval: (query) => {
      const ps = query.state.data?.provisionStatus
      const running = ps === "running"
      const idleWaiting =
        provisionFlowActive && (ps === "idle" || ps === undefined)
      const needsPoll = provisionFlowActive || running || idleWaiting
      if (!needsPoll) return false
      if (ps === "succeeded" || ps === "failed") return false
      return PROVISION_POLL_MS
    },
  })

  useEffect(() => {
    const ps = provisionStatusQuery.data?.provisionStatus
    if (ps === "running") {
      setProvisionFlowActive(true)
    }
  }, [provisionStatusQuery.data?.provisionStatus])

  useEffect(() => {
    if (!provisionFlowActive) return
    if (provisionStartedAtRef.current === null) return
    const check = () => {
      const startedAt = provisionStartedAtRef.current
      if (startedAt !== null && Date.now() - startedAt > PROVISION_TIMEOUT_MS) {
        setProvisionTimedOut(true)
        setProvisionFlowActive(false)
      }
    }
    const id = setInterval(check, 8000)
    check()
    return () => clearInterval(id)
  }, [provisionFlowActive])

  useEffect(() => {
    const ps = provisionStatusQuery.data?.provisionStatus
    if (ps !== "succeeded") return
    if (advancedAfterProvisionRef.current) return
    advancedAfterProvisionRef.current = true
    setProvisionFlowActive(false)
    provisionStartedAtRef.current = null
    void queryClient.invalidateQueries({
      queryKey: atlassianConnectorKeys.capabilities(
        orgSlug,
        atlassianConnectionId,
      ),
    })
    void queryClient.invalidateQueries({
      queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
    })
    onOpenedInstall()
  }, [
    provisionStatusQuery.data?.provisionStatus,
    queryClient,
    orgSlug,
    atlassianConnectionId,
    onOpenedInstall,
  ])

  useEffect(() => {
    if (provisionStatusQuery.data?.provisionStatus === "failed") {
      setProvisionFlowActive(false)
      provisionStartedAtRef.current = null
    }
  }, [provisionStatusQuery.data?.provisionStatus])

  const installIntentMutation = useMutation({
    mutationFn: () => registerAtlassianInstallIntent(orgSlug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
      })
    },
  })

  const siteTrimmed = confluenceSiteHost.trim()
  const tokenTrimmed = forgeScopedApiToken.trim()

  const provisionMutation = useMutation({
    mutationFn: () =>
      postForgeProvision(orgSlug, {
        connectionId: atlassianConnectionId,
        confluenceSiteHost: siteTrimmed,
        forgeScopedApiToken: tokenTrimmed,
      }),
    onMutate: () => {
      advancedAfterProvisionRef.current = false
      setProvisionTimedOut(false)
      setProvisionFlowActive(false)
    },
    onSuccess: async () => {
      provisionStartedAtRef.current = Date.now()
      setProvisionFlowActive(true)
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.forgeProvisionStatus(
          orgSlug,
          atlassianConnectionId,
        ),
      })
    },
  })

  const provStatus = provisionStatusQuery.data?.provisionStatus

  const isProvisioningBusy =
    provisionMutation.isPending ||
    provStatus === "running" ||
    (provisionFlowActive &&
      provStatus !== "succeeded" &&
      provStatus !== "failed")

  const provisionFailedMessage =
    provStatus === "failed"
      ? (provisionStatusQuery.data?.userMessage ??
        provisionStatusQuery.data?.provisionErrorCode ??
        "Forge provisioning failed")
      : null

  const submitProvision: FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    if (!siteTrimmed || !tokenTrimmed) return
    void provisionMutation.mutateAsync()
  }

  return (
    <div className="space-y-4">
      {isProvisioningBusy ? (
        <div className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/80 p-3">
          <Spinner className="mt-0.5 shrink-0 text-zinc-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">
              Provisioning Forge app
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              Registering and deploying via the deployment worker (
              <code className="text-xs text-zinc-300">forge install</code> on
              your site). You can leave this dialog open — this usually finishes
              in a few minutes.
            </p>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          {hasHostedInstall ? "Install Forge app" : "Provision Forge app"}
        </h3>
        {hasHostedInstall ? (
          <p className="mt-2 text-sm text-zinc-400">
            Install this deployment&apos;s Forge app to your Confluence site. A
            new window will open to complete the Atlassian install flow for the
            linked app URL.
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">
            Confluence integration requires an Atlassian Forge app, to
            provision please enter the following details.
          </p>
        )}
      </div>

      <div className="space-y-3">
        {hasHostedInstall ? (
          <>
            <Button
              variant="primary"
              isPending={installIntentMutation.isPending}
              onPress={() => {
                void installIntentMutation.mutateAsync()
                window.open(
                  installUrl ?? "",
                  "ctxpipe-forge-install",
                  "width=860,height=740",
                )
                onOpenedInstall()
                void queryClient.invalidateQueries({
                  queryKey: atlassianConnectorKeys.status(
                    orgSlug,
                    atlassianConnectionId,
                  ),
                })
              }}
            >
              Install Forge app
            </Button>
            {installIntentMutation.error ? (
              <p className="text-sm text-red-400">
                {installIntentMutation.error.message}
              </p>
            ) : null}
          </>
        ) : (
          <form className="space-y-3" onSubmit={submitProvision}>
            <TextField
              label="Confluence Cloud site hostname"
              description="Hostname of your Confluence site, usually <sitename>.atlassian.net."
              value={confluenceSiteHost}
              onChange={setConfluenceSiteHost}
              autoComplete="off"
            />
            <TextField
              label="Forge scoped API token"
              description={
                <>
                  Go to{" "}
                  <a
                    href="https://id.atlassian.com/manage-profile/security/api-tokens"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-teal-400 underline-offset-4 hover:text-teal-300 hover:underline"
                  >
                    https://id.atlassian.com/manage-profile/security/api-tokens
                  </a>
                  {" -> "}
                  create an API token{" -> "}select the Forge app integration
                  {" -> "}enable all scopes offered{" -> "}paste the generated
                  token in the field above.
                </>
              }
              type="password"
              value={forgeScopedApiToken}
              onChange={setForgeScopedApiToken}
              autoComplete="off"
            />
            <Button
              type="submit"
              variant="primary"
              isPending={provisionMutation.isPending}
              isDisabled={
                !siteTrimmed ||
                !tokenTrimmed ||
                provisionMutation.isPending ||
                provStatus === "running"
              }
            >
              Start provisioning
            </Button>
            {provisionMutation.error ? (
              <p className="text-sm text-red-400">
                {provisionMutation.error.message}
              </p>
            ) : null}
            {provisionFailedMessage ? (
              <p className="text-sm text-red-400">{provisionFailedMessage}</p>
            ) : null}
            {provisionTimedOut ? (
              <p className="text-sm text-amber-200/90">
                Provisioning is taking longer than expected. Confirm the worker
                is running Forge CLI provisioning, check server logs, then try
                again.
              </p>
            ) : null}
          </form>
        )}

        {caps.isError ? (
          <p className="text-sm text-amber-200/90">
            Could not load instance capabilities. The Install button uses the UI
            server mirror or bundled default Forge install URL until this
            request succeeds—after that, preferences from your deployment apply.
          </p>
        ) : null}
      </div>
    </div>
  )
}
