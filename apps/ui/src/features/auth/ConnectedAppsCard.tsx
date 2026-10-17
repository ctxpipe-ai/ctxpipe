import { IconPlugConnected, IconTrash } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"
import { OrganizationPicker } from "@/features/auth/OrganizationPicker"
import { userClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { useListOrganizations } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

export type ConnectedApp = Awaited<
  ReturnType<typeof fetchConnectedApps>
>[number]

async function fetchConnectedApps() {
  const res = await userClient.api.v1.me["connected-apps"].$get()
  const body = await readApiJson(res, {
    message: "Could not load connected apps",
  })
  return body.apps
}

const connectedAppsQueryKey = ["me", "connected-apps"] as const

const SCOPE_LABEL: Record<string, string> = {
  "ctxpipe:read": "Read",
  "ctxpipe:write": "Changes",
}

function scopeSummary(scopes: string[]): string {
  const labels = scopes.flatMap((scope) => SCOPE_LABEL[scope] ?? [])
  return labels.length > 0 ? labels.join(" and ") : "Sign-in only"
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed"
}

/**
 * The OAuth grants of the user: which orgs each client can reach. The user
 * edits the orgs or revokes the grant with no new connection in the client.
 */
export function ConnectedAppsCard() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<ConnectedApp | null>(null)
  const [revoking, setRevoking] = useState<ConnectedApp | null>(null)

  const appsQuery = useQuery({
    queryKey: connectedAppsQueryKey,
    queryFn: fetchConnectedApps,
  })

  const saveMutation = useMutation({
    mutationFn: async (input: { id: string; organizationIds: string[] }) => {
      const res = await userClient.api.v1.me["connected-apps"][
        ":consentId"
      ].organizations.$put({
        param: { consentId: input.id },
        json: { organizationIds: input.organizationIds },
      })
      await readApiJson(res, {
        message: "Could not save the organizations",
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectedAppsQueryKey })
      setEditing(null)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await userClient.api.v1.me["connected-apps"][
        ":consentId"
      ].$delete({ param: { consentId: id } })
      await readApiJson(res, {
        message: "Could not revoke the app",
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectedAppsQueryKey })
      setRevoking(null)
    },
  })

  const loading = useSkeletonHold(appsQuery.isPending)
  const apps = appsQuery.data ?? []

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <Card
        className={cn(
          betterAuthShellClassNames.card?.base,
          "ring-0 [&>span[aria-hidden]]:hidden",
        )}
      >
        <CardHeader>
          <CardTitle>Connected apps</CardTitle>
          <CardDescription className="max-w-prose">
            Apps that you connected to ctx| with OAuth, for example an MCP
            client. Each app can reach only the organizations you select.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            // The box of the app list: the same card border, padding and gap.
            <div aria-hidden className="flex flex-col gap-2">
              {[1, 2].map((row) => (
                <div
                  key={row}
                  className="flex flex-col gap-3 rounded-md border border-transparent p-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <SkeletonText
                      className="text-sm"
                      boneClassName="w-40 max-w-full"
                    />
                    <SkeletonText
                      className="text-xs"
                      boneClassName="w-56 max-w-full"
                    />
                  </div>
                  {/* The two buttons of a loaded row: Edit organizations, Revoke. */}
                  <div className="flex shrink-0 items-center gap-2">
                    {/* The hidden labels give each bone the width of its button in any font. */}
                    <Skeleton className="box-border inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-transparent px-3.5 text-sm">
                      <span className="invisible">Edit organizations</span>
                    </Skeleton>
                    <Skeleton className="box-border inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-transparent px-3.5 text-sm">
                      <span className="invisible size-4" />
                      <span className="invisible">Revoke</span>
                    </Skeleton>
                  </div>
                </div>
              ))}
            </div>
          ) : appsQuery.error ? (
            <InlineAlert variant="error" title="Could not load connected apps">
              {errorText(appsQuery.error)}. Refresh the page and try again.
            </InlineAlert>
          ) : apps.length === 0 ? (
            <div className="flex max-w-prose items-start gap-3">
              <span className="ctx-node h-9 w-9 shrink-0">
                <IconPlugConnected
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">
                  No connected apps
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  When you allow an app on the consent page, it shows here.
                </p>
              </div>
            </div>
          ) : (
            <ul aria-label="Connected apps" className="flex flex-col gap-2">
              {apps.map((app) => {
                const name = app.clientName || app.clientId
                return (
                  <li
                    key={app.id}
                    className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="text-xs text-muted-foreground">
                        {scopeSummary(app.scopes)}
                        <span className="mx-1.5 text-zinc-600">·</span>
                        {app.organizations.length > 0 ? (
                          <span className="font-mono">
                            {app.organizations
                              .map((org) => org.slug)
                              .join(", ")}
                          </span>
                        ) : (
                          "No organizations"
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {app.legacy ? (
                        <p className="max-w-48 text-xs text-muted-foreground">
                          Reconnect to choose more organizations
                        </p>
                      ) : (
                        <Button
                          variant="outline"
                          className="rounded-md"
                          aria-label={`Edit organizations of ${name}`}
                          onPress={() => {
                            saveMutation.reset()
                            setEditing(app)
                          }}
                        >
                          Edit organizations
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        className="rounded-md"
                        aria-label={`Revoke ${name}`}
                        onPress={() => {
                          revokeMutation.reset()
                          setRevoking(app)
                        }}
                      >
                        <IconTrash className="size-4" aria-hidden />
                        Revoke
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <EditOrganizationsModal
          app={editing}
          isPending={saveMutation.isPending}
          error={saveMutation.error ? errorText(saveMutation.error) : null}
          onClose={() => {
            if (!saveMutation.isPending) setEditing(null)
          }}
          onSave={(organizationIds) =>
            saveMutation.mutate({ id: editing.id, organizationIds })
          }
        />
      ) : null}

      {revoking ? (
        <RevokeModal
          name={revoking.clientName || revoking.clientId}
          isPending={revokeMutation.isPending}
          error={revokeMutation.error ? errorText(revokeMutation.error) : null}
          onClose={() => {
            if (!revokeMutation.isPending) setRevoking(null)
          }}
          onRevoke={() => revokeMutation.mutate(revoking.id)}
        />
      ) : null}
    </div>
  )
}

function EditOrganizationsModal(props: {
  app: ConnectedApp
  isPending: boolean
  error: string | null
  onClose: () => void
  onSave: (organizationIds: string[]) => void
}) {
  const { app, isPending, error, onClose, onSave } = props
  const { data: organizations, isPending: organizationsPending } =
    useListOrganizations()
  const [value, setValue] = useState(() =>
    app.organizations.map((org) => org.id),
  )
  const name = app.clientName || app.clientId
  return (
    <Modal
      isOpen
      isDismissable={!isPending}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog>
        <div className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Organizations for {name}</DialogTitle>
            <DialogDescription>
              The app can reach only the organizations you select. The change
              applies to its next call.
            </DialogDescription>
          </DialogHeader>
          {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
          {organizationsPending ? (
            // The box of `OrganizationPicker`: a check box and two text lines per row.
            <div aria-hidden className="flex flex-col gap-2">
              <SkeletonText className="text-sm" boneClassName="h-3.5 w-24" />
              {[0, 1].map((row) => (
                <div key={row} className="flex items-center gap-2">
                  <Skeleton className="size-4.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <SkeletonText className="text-sm" boneClassName="w-40" />
                    <SkeletonText className="text-xs" boneClassName="w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <OrganizationPicker
              organizations={(organizations ?? []).map(
                ({ id, name: orgName, slug }) => ({ id, name: orgName, slug }),
              )}
              value={value}
              onChange={setValue}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              className="rounded-md"
              isDisabled={isPending}
              onPress={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              className="rounded-md"
              isDisabled={isPending || value.length === 0}
              isPending={isPending}
              onPress={() => onSave(value)}
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </Modal>
  )
}

/**
 * Confirm a revoke. The dialog stays open until the request settles: it
 * closes on success and shows the error on failure.
 */
function RevokeModal(props: {
  name: string
  isPending: boolean
  error: string | null
  onClose: () => void
  onRevoke: () => void
}) {
  const { name, isPending, error, onClose, onRevoke } = props
  return (
    <Modal
      isOpen
      isDismissable={!isPending}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog role="alertdialog">
        <div className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Revoke {name}?</DialogTitle>
            <DialogDescription>
              The app loses access at once. To use it again, connect it again.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <InlineAlert variant="error" title="Could not revoke">
              {error}
            </InlineAlert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              className="rounded-md"
              isDisabled={isPending}
              onPress={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="rounded-md"
              isPending={isPending}
              isDisabled={isPending}
              onPress={onRevoke}
            >
              Revoke app
            </Button>
          </div>
        </div>
      </Dialog>
    </Modal>
  )
}
