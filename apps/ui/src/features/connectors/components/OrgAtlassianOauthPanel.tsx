"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
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
    <p className={embedded ? "text-sm text-zinc-400" : "text-xs text-zinc-500"}>
      {embedded ? (
        <>
          Create an{" "}
          <a
            href="https://developer.atlassian.com/cloud/oauth-2-3lo-apps"
            className="text-teal-500 underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            OAuth 2.0 (3LO) app
          </a>{" "}
          in the Atlassian developer console, then enter its credentials.
          Register this callback:{" "}
        </>
      ) : (
        <>Register an app in the Atlassian developer console. Callback URL: </>
      )}
      <code
        className={
          embedded
            ? "text-xs break-all text-zinc-300"
            : "break-all text-zinc-400"
        }
      >
        {meta.data?.oauthCallbackUrl ?? "…"}
      </code>
      {embedded
        ? ". The client secret is stored encrypted and is not shown again after you save."
        : " . The secret is never shown again after you save."}
    </p>
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
