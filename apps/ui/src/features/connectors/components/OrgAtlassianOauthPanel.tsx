"use client"

import { IconCopy } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { displayOAuthCallbackUrl } from "../lib/display-oauth-callback-url"
import {
  atlassianConnectorKeys,
  fetchOrgAtlassianOauth,
} from "../queries/atlassian-connector"
import { AtlassianOauthAppSavedSection } from "./AtlassianOauthAppSavedSection"

type OrgAtlassianOauthPanelProps = {
  orgSlug: string
  connectionId: string
  /**
   * When true, render without the outer card chrome (e.g. wizard). When false, use the standalone
   * card for the connectors page.
   */
  embedded?: boolean
}

function AtlassianThreeLoSetupGuide({
  oauthCallbackUrl,
  mutedClass,
}: {
  oauthCallbackUrl?: string
  mutedClass: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const callbackDisplay = oauthCallbackUrl ?? "…"

  const onCopyCallback = async () => {
    if (!oauthCallbackUrl) return
    try {
      await navigator.clipboard.writeText(oauthCallbackUrl)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 2000)
    }
  }

  const code = (ch: string) => (
    <code className="rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[0.8125rem] text-zinc-200">
      {ch}
    </code>
  )

  return (
    <div className="space-y-3">
      <ol className={`list-decimal space-y-3 pl-5 ${mutedClass}`}>
        <li>
          Go to the{" "}
          <a
            href="https://developer.atlassian.com/console/myapps/create-3lo-app"
            className="text-teal-500 underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Atlassian developer console
          </a>{" "}
          and create an OAuth 2.0 (3LO) app with a name you prefer.
        </li>
        <li>
          Open{" "}
          <strong className="font-medium text-zinc-300">Authorization</strong> →{" "}
          <strong className="font-medium text-zinc-300">OAuth 2.0 (3LO)</strong>{" "}
          → <strong className="font-medium text-zinc-300">Add</strong>. Paste
          this callback URL, then save.
          <div className="mt-2 flex flex-wrap items-stretch gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-2 font-mono text-xs text-zinc-200">
              {callbackDisplay}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="shrink-0"
              aria-label={
                copyState === "copied"
                  ? "Callback URL copied"
                  : "Copy callback URL"
              }
              title={
                copyState === "copied"
                  ? "Copied"
                  : copyState === "error"
                    ? "Copy failed"
                    : "Copy callback URL"
              }
              isDisabled={!oauthCallbackUrl}
              onPress={() => void onCopyCallback()}
            >
              <IconCopy className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          {copyState !== "idle" ? (
            <output
              aria-live="polite"
              className="mt-1 block text-xs text-teal-500"
            >
              {copyState === "copied"
                ? "Copied to clipboard."
                : "Could not copy — copy the URL manually."}
            </output>
          ) : null}
        </li>
        <li>
          Under{" "}
          <strong className="font-medium text-zinc-300">Permissions</strong>,{" "}
          <strong className="font-medium text-zinc-300">
            Add &amp; configure
          </strong>{" "}
          following scopes:
          <ul className={`mt-2 list-disc space-y-1.5 pl-5 ${mutedClass}`}>
            <li>
              <span className="text-zinc-300">User identity:</span>{" "}
              {code("read:me")}, {code("read:account")}
            </li>
            <li>
              <span className="text-zinc-300">Confluence:</span>{" "}
              {code("read:confluence-user")}
            </li>
            <li>
              <span className="text-zinc-300">Jira:</span>{" "}
              {code("read:jira-user")}
            </li>
          </ul>
        </li>
        <li>
          Under <strong className="font-medium text-zinc-300">Settings</strong>,
          copy the{" "}
          <strong className="font-medium text-zinc-300">Client ID</strong> and{" "}
          <strong className="font-medium text-zinc-300">Secret</strong> and
          paste them into the fields below.
        </li>
      </ol>
      <p className={mutedClass}>
        The client secret is stored encrypted and is not shown again after you
        save.
      </p>
    </div>
  )
}

export function OrgAtlassianOauthPanel({
  orgSlug,
  connectionId,
  embedded = false,
}: OrgAtlassianOauthPanelProps) {
  const queryClient = useQueryClient()
  const meta = useQuery({
    queryKey: atlassianConnectorKeys.orgAtlassianOauth(orgSlug, connectionId),
    queryFn: () => fetchOrgAtlassianOauth(orgSlug, connectionId),
  })
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")

  const save = useMutation({
    mutationFn: async () => {
      const q = new URLSearchParams({ connectionId })
      const res = await fetch(
        `/${orgSlug}/api/v1/org/atlassian-oauth?${q.toString()}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret }),
        },
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? res.statusText)
      }
    },
    onSuccess: async () => {
      setClientSecret("")
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.orgAtlassianOauth(
          orgSlug,
          connectionId,
        ),
      })
    },
  })

  if (meta.data?.oauthAppSaved) {
    return (
      <AtlassianOauthAppSavedSection
        embedded={embedded}
        orgSlug={orgSlug}
        connectionId={connectionId}
        savedClientId={meta.data.atlassianOAuthClientId ?? ""}
      />
    )
  }

  const help = (
    <AtlassianThreeLoSetupGuide
      oauthCallbackUrl={displayOAuthCallbackUrl(meta.data?.oauthCallbackUrl)}
      mutedClass={embedded ? "text-sm text-zinc-400" : "text-sm text-zinc-500"}
    />
  )

  return (
    <div
      className={
        embedded
          ? "max-w-lg space-y-3"
          : "max-w-lg space-y-3 rounded-md border border-zinc-800 p-4"
      }
    >
      {embedded ? null : (
        <h3 className="text-sm font-semibold text-zinc-100">
          Atlassian OAuth (3LO)
        </h3>
      )}
      {help}
      <TextField
        label="Client ID"
        value={clientId}
        onChange={(v) => {
          setClientId(v)
        }}
        autoComplete="off"
      />
      <TextField
        label="Client secret"
        value={clientSecret}
        onChange={(v) => {
          setClientSecret(v)
        }}
        type="password"
        autoComplete="off"
      />
      <Button
        variant="primary"
        isPending={save.isPending}
        isDisabled={meta.isPending}
        onPress={() => {
          if (!clientId || !clientSecret) return
          void save.mutateAsync()
        }}
      >
        Save OAuth app
      </Button>
      {save.error ? (
        <p className="text-sm text-red-400">{save.error.message}</p>
      ) : null}
    </div>
  )
}
