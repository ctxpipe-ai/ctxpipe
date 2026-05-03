import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEventHandler, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Spinner } from "@/components/ui/spinner"
import { TextField } from "@/components/ui/TextField"
import { useConfluenceForgeRuntime } from "@/providers/ConfluenceForgeRuntimeContext"
import {
  atlassianConnectorKeys,
  type ForgeProvisionStatusPayload,
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
const PROVISION_SUCCESS_MS = 550

function pickHttps(candidate: string | null | undefined): string | null {
  const s = candidate?.trim()
  if (!s || !s.startsWith("https://")) return null
  return s
}

export function InstallForgeStep({
  orgSlug,
  atlassianConnectionId,
  onOpenedInstall,
}: InstallForgeStepProps) {
  const queryClient = useQueryClient()
  const forgeRuntime = useConfluenceForgeRuntime()

  const [confluenceSiteHost, setConfluenceSiteHost] = useState("")
  const [forgeScopedApiToken, setForgeScopedApiToken] = useState("")
  const [forgeOperatorEmail, setForgeOperatorEmail] = useState("")
  const [provisionFlowActive, setProvisionFlowActive] = useState(false)
  const [provisionTimedOut, setProvisionTimedOut] = useState(false)
  const [provisionSuccessVisible, setProvisionSuccessVisible] = useState(false)

  const advancedAfterProvisionRef = useRef(false)
  const provisionStartedAtRef = useRef<number | null>(null)

  const caps = useQuery({
    queryKey: atlassianConnectorKeys.capabilities(
      orgSlug,
      atlassianConnectionId,
    ),
    queryFn: () => fetchOrgCapabilities(orgSlug, atlassianConnectionId),
  })

  const capsResolved = caps.isSuccess || caps.isError
  const capabilitiesLoading = !capsResolved

  /** Only after capabilities load: server URL means hosted Marketplace install; omit bundled default to avoid hosted→self-hosted flash. */
  const installUrl = caps.isSuccess
    ? pickHttps(caps.data.confluenceForgeInstallUrl)
    : null

  const hasHostedInstall = caps.isSuccess && Boolean(installUrl)

  const forgeProvisionQueryKey = atlassianConnectorKeys.forgeProvisionStatus(
    orgSlug,
    atlassianConnectionId,
  )

  const provisionStatusQuery = useQuery({
    queryKey: forgeProvisionQueryKey,
    queryFn: () => fetchForgeProvisionStatus(orgSlug, atlassianConnectionId),
    enabled:
      Boolean(atlassianConnectionId) && caps.isSuccess && !hasHostedInstall,
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
  const emailTrimmed = forgeOperatorEmail.trim()

  const provisionMutation = useMutation({
    mutationFn: () =>
      postForgeProvision(orgSlug, {
        connectionId: atlassianConnectionId,
        confluenceSiteHost: siteTrimmed,
        forgeScopedApiToken: tokenTrimmed,
        forgeOperatorEmail: emailTrimmed,
      }),
    onMutate: () => {
      advancedAfterProvisionRef.current = false
      setProvisionTimedOut(false)
      setProvisionFlowActive(false)
      setProvisionSuccessVisible(false)
    },
    onSuccess: async () => {
      provisionStartedAtRef.current = Date.now()
      setProvisionFlowActive(true)
      queryClient.setQueryData(
        forgeProvisionQueryKey,
        (prev): ForgeProvisionStatusPayload => ({
          ...(prev ?? {
            connectionId: atlassianConnectionId,
            provisionStatus: "idle",
            provisionErrorCode: null,
            userMessage: null,
          }),
          connectionId: atlassianConnectionId,
          provisionStatus: "running",
          provisionErrorCode: null,
          userMessage: null,
        }),
      )
      await queryClient.invalidateQueries({
        queryKey: forgeProvisionQueryKey,
      })
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
    setProvisionSuccessVisible(true)
    const t = window.setTimeout(() => {
      setProvisionSuccessVisible(false)
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
    }, PROVISION_SUCCESS_MS)
    return () => clearTimeout(t)
  }, [
    provisionStatusQuery.data?.provisionStatus,
    queryClient,
    orgSlug,
    atlassianConnectionId,
    onOpenedInstall,
  ])

  useEffect(() => {
    if (provisionStatusQuery.data?.provisionStatus !== "failed") return
    if (provisionMutation.isPending) return
    setProvisionFlowActive(false)
    provisionStartedAtRef.current = null
  }, [provisionStatusQuery.data?.provisionStatus, provisionMutation.isPending])

  const provStatus = provisionStatusQuery.data?.provisionStatus

  const isProvisioningBusy =
    !provisionSuccessVisible &&
    (provisionMutation.isPending ||
      provStatus === "running" ||
      (provisionFlowActive && provStatus !== "succeeded"))

  const provisionFailedMessage =
    provStatus === "failed"
      ? (provisionStatusQuery.data?.userMessage ??
        provisionStatusQuery.data?.provisionErrorCode ??
        "Forge provisioning failed")
      : null

  const formLocked = isProvisioningBusy || provisionSuccessVisible

  const provisionErrorCombined =
    provisionMutation.error?.message ??
    provisionFailedMessage ??
    (provisionTimedOut
      ? "Provisioning is taking longer than expected. Confirm the worker is running Forge CLI provisioning, check server logs, then try again."
      : null)

  const showProvisionError =
    Boolean(provisionErrorCombined) &&
    !provisionMutation.isPending &&
    !isProvisioningBusy

  const submitProvision: FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault()
    if (isProvisioningBusy || !siteTrimmed || !tokenTrimmed || !emailTrimmed)
      return
    provisionMutation.reset()
    queryClient.setQueryData(
      forgeProvisionQueryKey,
      (prev): ForgeProvisionStatusPayload => ({
        ...(prev ?? {
          connectionId: atlassianConnectionId,
          provisionStatus: "idle",
          provisionErrorCode: null,
          userMessage: null,
        }),
        connectionId: atlassianConnectionId,
        provisionStatus: "idle",
        provisionErrorCode: null,
        userMessage: null,
      }),
    )
    void provisionMutation.mutateAsync()
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          {capabilitiesLoading
            ? "Forge app setup"
            : hasHostedInstall
              ? "Install Forge app"
              : "Provision Forge app"}
        </h3>
        {capabilitiesLoading ? (
          <p className="mt-2 text-sm text-zinc-400">
            Checking how this deployment exposes the Forge install flow…
          </p>
        ) : hasHostedInstall ? (
          <p className="mt-2 text-sm text-zinc-400">
            Install this deployment&apos;s Forge app to your Confluence site. A
            new window will open to complete the Atlassian install flow for the
            linked app URL.
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">
            Confluence integrations use embedded Forge apps on Atlassian’s
            cloud. ctx| will provision one for you below.{" "}
            <a
              href="https://developer.atlassian.com/platform/forge/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-teal-400 underline-offset-4 hover:text-teal-300 hover:underline"
            >
              Learn what Forge is
            </a>
            .
          </p>
        )}
      </div>

      {capabilitiesLoading ? (
        <div className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-3">
          <Spinner className="shrink-0 text-zinc-400" />
          <p className="text-sm text-zinc-300">Loading install options…</p>
        </div>
      ) : null}

      {provisionSuccessVisible ? (
        <InlineAlert variant="success" title="Forge app provisioned">
          <p>
            Waiting for Atlassian to confirm installation on your site — next
            step opens in a moment.
          </p>
        </InlineAlert>
      ) : null}

      <div className="space-y-3">
        {caps.isError ? (
          <InlineAlert variant="warning" title="Could not load capabilities">
            <p>
              This step falls back to self-hosted provisioning only. If your
              deployment normally provides a hosted Forge install link, fix the
              capabilities request and reopen setup.
            </p>
            <p className="mt-2 text-xs text-amber-100/80">
              Bundled default (
              <code className="text-[11px]">CONFLUENCE_FORGE_INSTALL_URL</code>)
              is not used to choose the UI until the server responds; runtime
              fallback is still{" "}
              {pickHttps(forgeRuntime.installUrlFallback) ??
                pickHttps(CONFLUENCE_FORGE_INSTALL_URL) ??
                "none"}
              .
            </p>
          </InlineAlert>
        ) : null}

        {caps.isSuccess && hasHostedInstall ? (
          <>
            <Button
              variant="primary"
              isPending={installIntentMutation.isPending}
              isDisabled={installIntentMutation.isPending}
              onPress={async () => {
                try {
                  await installIntentMutation.mutateAsync()
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
                } catch {
                  /* mutation surfaces error below */
                }
              }}
            >
              Install Forge app
            </Button>
            {installIntentMutation.isError ? (
              <InlineAlert variant="error" title="Could not start install">
                <p>{installIntentMutation.error.message}</p>
              </InlineAlert>
            ) : null}
          </>
        ) : null}

        {caps.isSuccess && !hasHostedInstall ? (
          <form className="space-y-3" onSubmit={submitProvision}>
            <TextField
              label="Confluence Cloud site hostname"
              description={
                <>
                  Hostname of your Confluence site, usually{" "}
                  <code className="rounded bg-zinc-800/80 px-1 font-mono text-xs text-zinc-300">
                    &lt;sitename&gt;.atlassian.net
                  </code>
                  .
                </>
              }
              value={confluenceSiteHost}
              onChange={setConfluenceSiteHost}
              autoComplete="off"
              isDisabled={formLocked}
            />
            <TextField
              label="Atlassian account email"
              description="Your Atlassian account email—the same address you use for Atlassian. To double-check, click your avatar in the top-right and look in the menu for your email."
              type="email"
              value={forgeOperatorEmail}
              onChange={setForgeOperatorEmail}
              autoComplete="email"
              isDisabled={formLocked}
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
                  token here.
                </>
              }
              type="password"
              value={forgeScopedApiToken}
              onChange={setForgeScopedApiToken}
              autoComplete="off"
              isDisabled={formLocked}
            />
            {isProvisioningBusy ? (
              <div className="mt-6 flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/80 p-3">
                <Spinner className="mt-0.5 shrink-0 text-zinc-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">
                    Provisioning Forge app
                  </p>
                  <p className="mt-1 text-sm text-zinc-400">
                    Creating and deploying the app on your behalf. This may take
                    a minute or two—you can leave this dialog open.
                  </p>
                </div>
              </div>
            ) : provisionSuccessVisible ? null : (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={!siteTrimmed || !tokenTrimmed || !emailTrimmed}
                >
                  {showProvisionError ? "Try again" : "Start provisioning"}
                </Button>
              </div>
            )}
            {showProvisionError && provisionErrorCombined ? (
              <InlineAlert variant="error" title="Provisioning issue">
                <p>{provisionErrorCombined}</p>
              </InlineAlert>
            ) : null}
          </form>
        ) : null}
      </div>
    </div>
  )
}
