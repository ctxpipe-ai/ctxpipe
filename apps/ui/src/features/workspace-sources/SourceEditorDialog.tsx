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
import {
  createWorkspaceSource,
  sourceChangeMessage,
  updateWorkspaceSource,
  type WorkspaceSource,
  workspaceSourceKeys,
} from "./queries"
import { SOURCE_PROVIDER_UI, sourceProviderLabel } from "./source-provider-ui"

export type SourceEditorTarget =
  | { kind: "add"; provider: SourceProvider }
  | { kind: "edit"; provider: SourceProvider; source: WorkspaceSource }

/** A connection that a source can use, with the name the provider gives. */
export type SourceConnectionOption = { id: string; displayName: string | null }

/**
 * Add or edit one source of a Workspace. The body is the provider scope
 * editor slot. The change goes to `.ctxpipe/sources.yaml` by a pull request.
 */
export function SourceEditorDialog(props: {
  orgSlug: string
  workspaceSlug: string
  /** The connections of this provider in the org. */
  connections: SourceConnectionOption[]
  target: SourceEditorTarget
  onClose: () => void
}) {
  const { orgSlug, workspaceSlug, connections, target, onClose } = props
  const { provider } = target
  const editing = target.kind === "edit" ? target.source : null
  const queryClient = useQueryClient()
  const [connectionId, setConnectionId] = useState<string | null>(
    editing?.connectionId ?? connections[0]?.id ?? null,
  )
  const [scope, setScope] = useState<Record<string, unknown> | null>(
    editing?.scope ?? {},
  )
  const { ScopeEditor } = SOURCE_PROVIDER_UI[provider]
  const label = sourceProviderLabel(provider)
  const valid =
    connectionId != null &&
    scope != null &&
    SOURCE_SCOPES[provider].schema.safeParse(scope).success

  const saveMutation = useMutation({
    mutationFn: (input: {
      connectionId: string
      scope: Record<string, unknown>
    }) => {
      const source = { provider, ...input }
      return editing
        ? updateWorkspaceSource(
            orgSlug,
            workspaceSlug,
            editing.sourceKey,
            source,
          )
        : createWorkspaceSource(orgSlug, workspaceSlug, source)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      toast.success(sourceChangeMessage())
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
          The change goes to the sources file of this Workspace.
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
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="quiet" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!valid}
            isPending={saveMutation.isPending}
            onPress={() => {
              if (connectionId && scope)
                saveMutation.mutate({
                  connectionId,
                  scope,
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
