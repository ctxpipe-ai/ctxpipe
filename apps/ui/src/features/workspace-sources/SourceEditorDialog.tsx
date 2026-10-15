import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  SOURCE_SCOPES,
  type SourceProvider,
} from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { Select, SelectItem } from "@/components/ui/Select"
import { TextField } from "@/components/ui/TextField"
import {
  createWorkspaceSource,
  type SourceDelivery,
  sourceChangeMessage,
  updateWorkspaceSource,
  type WorkspaceSource,
  workspaceSourceKeys,
} from "./queries"
import { SOURCE_PROVIDER_UI, sourceProviderLabel } from "./source-provider-ui"

/** One path segment of a source file name (the rule of `source-file.ts`). */
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/

export type SourceEditorTarget =
  | { kind: "add"; provider: SourceProvider }
  | { kind: "edit"; provider: SourceProvider; source: WorkspaceSource }

/** A connection that a source can use, with the name the provider gives. */
export type SourceConnectionOption = { id: string; displayName: string | null }

/**
 * Add or edit one source file of a Workspace. The body is the provider scope
 * editor slot, an optional file name (add only), and the description. The
 * change goes to `sources/` by a pull request, or by a direct commit when
 * the Workspace allows one.
 */
export function SourceEditorDialog(props: {
  orgSlug: string
  workspaceSlug: string
  /** The connections of this provider in the org. */
  connections: SourceConnectionOption[]
  directCommitAllowed: boolean
  target: SourceEditorTarget
  onClose: () => void
}) {
  const {
    orgSlug,
    workspaceSlug,
    connections,
    directCommitAllowed,
    target,
    onClose,
  } = props
  const { provider } = target
  const editing = target.kind === "edit" ? target.source : null
  const queryClient = useQueryClient()
  const [connectionId, setConnectionId] = useState<string | null>(
    editing?.connectionId ?? connections[0]?.id ?? null,
  )
  const [scope, setScope] = useState<Record<string, unknown> | null>(
    editing?.scope ?? {},
  )
  const [name, setName] = useState("")
  const [description, setDescription] = useState(editing?.description ?? "")
  const { ScopeEditor } = SOURCE_PROVIDER_UI[provider]
  const label = sourceProviderLabel(provider)
  const valid =
    connectionId != null &&
    scope != null &&
    SOURCE_SCOPES[provider].schema.safeParse(scope).success &&
    (editing != null || name === "" || SOURCE_NAME.test(name))

  const saveMutation = useMutation({
    mutationFn: (input: {
      connectionId: string
      scope: Record<string, unknown>
      delivery: SourceDelivery
    }) => {
      const { delivery, ...rest } = input
      // An edit that never saw the description keeps the body, unless the
      // user typed one.
      const unchanged = description === (editing?.description ?? "")
      const source = {
        provider,
        ...rest,
        ...(editing && unchanged && editing.description == null
          ? {}
          : { description }),
      }
      return editing
        ? updateWorkspaceSource(
            orgSlug,
            workspaceSlug,
            editing.path,
            source,
            delivery,
          )
        : createWorkspaceSource(
            orgSlug,
            workspaceSlug,
            source,
            delivery,
            name ? `sources/${provider}/${name}.md` : undefined,
          )
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      toast.success(sourceChangeMessage(result))
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      isDismissable={!saveMutation.isPending}
      size="medium"
      placement="top"
    >
      <Dialog>
        <Heading
          slot="title"
          className="my-0 text-lg font-medium leading-6 text-foreground"
        >
          {editing ? `Edit ${label} source` : `Add ${label} source`}
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          {editing
            ? `The change goes to ${editing.path}.`
            : "The change adds a file under sources/ in this Workspace."}
        </p>
        <div className="mt-5 flex flex-col gap-4">
          {connections.length > 1 ? (
            <Select
              label="Connection"
              selectedKey={connectionId}
              onSelectionChange={(key) =>
                setConnectionId(key == null ? null : String(key))
              }
            >
              {connections.map((connection) => (
                <SelectItem key={connection.id} id={connection.id}>
                  {connection.displayName ?? `${label} connection`}
                </SelectItem>
              ))}
            </Select>
          ) : null}
          {connectionId ? (
            <ScopeEditor
              key={connectionId}
              orgSlug={orgSlug}
              provider={provider}
              connectionId={connectionId}
              initialScope={editing?.scope ?? {}}
              onChange={setScope}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Connect {label} on the Connectors page first.
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-4">
          {editing ? null : (
            <TextField
              label="File name (optional)"
              value={name}
              onChange={setName}
              placeholder={provider}
              description={`Saved as sources/${provider}/${name || provider}.md`}
              isInvalid={name !== "" && !SOURCE_NAME.test(name)}
              errorMessage="Use lowercase letters, digits, '.', '_', and '-'."
            />
          )}
          <TextField
            label="Description (optional)"
            value={description}
            onChange={setDescription}
            rows={3}
            description="What this source is for. People and agents read it."
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="quiet" onPress={onClose}>
            Cancel
          </Button>
          {directCommitAllowed ? (
            <Button
              variant="secondary"
              isDisabled={!valid || saveMutation.isPending}
              onPress={() => {
                if (connectionId && scope)
                  saveMutation.mutate({
                    connectionId,
                    scope,
                    delivery: "commit",
                  })
              }}
            >
              Commit directly
            </Button>
          ) : null}
          <Button
            variant="primary"
            isDisabled={!valid}
            isPending={saveMutation.isPending}
            onPress={() => {
              if (connectionId && scope)
                saveMutation.mutate({
                  connectionId,
                  scope,
                  delivery: "pull_request",
                })
            }}
          >
            Open a pull request
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
