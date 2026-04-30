"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { atlassianConnectorKeys } from "../queries/atlassian-connector"

export type AtlassianOauthAppSavedSectionProps = {
  orgSlug: string
  connectionId: string
  /**
   * Public OAuth app client id from the server (only non-secret id is ever exposed).
   * Empty when unknown (e.g. legacy row); the form can still be used to re-save.
   */
  savedClientId: string
  /** Lighter layout when nested in the Confluence setup wizard. */
  embedded?: boolean
  /**
   * When the parent shows the same summary as a disclosure trigger (e.g. Link Atlassian), omit the
   * duplicate “configured” heading inside the panel.
   */
  hideSavedHeading?: boolean
}

/**
 * Shown when a 3LO app is stored for the connection: show client id, never the secret, and allow
 * updates (new secret optional so the current secret can be kept).
 */
export function AtlassianOauthAppSavedSection({
  orgSlug,
  connectionId,
  savedClientId,
  embedded = false,
  hideSavedHeading = false,
}: AtlassianOauthAppSavedSectionProps) {
  const queryClient = useQueryClient()
  const [clientId, setClientId] = useState(savedClientId)
  const [newClientSecret, setNewClientSecret] = useState("")

  useEffect(() => {
    setClientId(savedClientId)
  }, [savedClientId])

  const save = useMutation({
    mutationFn: async () => {
      const q = new URLSearchParams({ connectionId })
      const body: { clientId: string; clientSecret?: string } = {
        clientId: clientId.trim(),
      }
      if (newClientSecret.trim()) {
        body.clientSecret = newClientSecret.trim()
      }
      const res = await fetch(
        `/${orgSlug}/api/v1/org/atlassian-oauth?${q.toString()}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? res.statusText)
      }
    },
    onSuccess: async () => {
      setNewClientSecret("")
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.orgAtlassianOauth(
          orgSlug,
          connectionId,
        ),
      })
    },
  })

  return (
    <div
      className={
        embedded
          ? "max-w-lg space-y-3"
          : "max-w-lg space-y-3 rounded-md border border-zinc-800 p-4"
      }
    >
      <div className="space-y-2 text-sm text-zinc-400">
        {hideSavedHeading ? null : (
          <p className="font-medium text-zinc-100">
            OAuth (3LO) app is configured for this connection.
          </p>
        )}
        {savedClientId ? (
          <p>
            Client ID:{" "}
            <code
              className="break-all rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-zinc-200"
              title={savedClientId}
            >
              {savedClientId}
            </code>
          </p>
        ) : (
          <p>
            We have a client secret on file for this connection, but the client
            id could not be read. You can re-enter the client id below.
          </p>
        )}
        <p className="text-zinc-500">
          The client secret is stored on the server and is never returned. To
          rotate it, enter a new secret below. To only change the client id,
          update the field and save without a new secret.
        </p>
      </div>
      <div className="space-y-3">
        <TextField
          label="Client ID"
          value={clientId}
          onChange={(v) => {
            setClientId(v)
          }}
          autoComplete="off"
        />
        <TextField
          label="New client secret"
          value={newClientSecret}
          onChange={(v) => {
            setNewClientSecret(v)
          }}
          type="password"
          autoComplete="off"
          description="Leave empty to keep the current secret."
        />
        <Button
          variant="secondary"
          isPending={save.isPending}
          onPress={() => {
            if (!clientId.trim()) return
            void save.mutateAsync()
          }}
        >
          Update OAuth app
        </Button>
        {save.error ? (
          <p className="text-sm text-red-400">{save.error.message}</p>
        ) : null}
      </div>
    </div>
  )
}
