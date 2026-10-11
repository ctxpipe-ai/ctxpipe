import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { ChooseWorkspacesStep } from "./ChooseWorkspacesStep"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"
import { createWorkspaceSource, workspaceSourceKeys } from "./queries"
import { sourceProviderLabel } from "./source-provider-ui"

/** "Add to a Workspace" from a connector: the Choose Workspaces step alone. */
export function AddToWorkspacesDialog(props: {
  orgSlug: string
  connectionId: string
  provider: SourceProvider
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { orgSlug, connectionId, provider, isOpen, onOpenChange } = props
  const queryClient = useQueryClient()
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const requests = chooseWorkspacesRequests(value, { provider, connectionId })

  const close = () => {
    setValue(emptyChooseWorkspaces())
    onOpenChange(false)
  }

  const addMutation = useMutation({
    mutationFn: (list: NonNullable<typeof requests>) =>
      Promise.all(
        list.map((request) =>
          createWorkspaceSource(orgSlug, request.workspaceSlug, request.source),
        ),
      ),
    onSuccess: (results, list) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.usage(orgSlug, connectionId),
      })
      for (const request of list)
        void queryClient.invalidateQueries({
          queryKey: workspaceSourceKeys.list(orgSlug, request.workspaceSlug),
        })
      toast.success(
        results.some((result) => result.outcome === "pull_request")
          ? "Pull request opened. The source starts to sync after the merge."
          : "Source added",
      )
      close()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? onOpenChange(true) : close())}
      isDismissable={!addMutation.isPending}
      size="medium"
      placement="top"
    >
      <Dialog>
        <Heading
          slot="title"
          className="my-0 text-lg font-medium leading-6 text-foreground"
        >
          Add {sourceProviderLabel(provider)} to Workspaces
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Select the Workspaces that sync from this connector.
        </p>
        <div className="mt-5">
          <ChooseWorkspacesStep
            orgSlug={orgSlug}
            provider={provider}
            connectionId={connectionId}
            value={value}
            onChange={setValue}
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="quiet" onPress={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!requests}
            isPending={addMutation.isPending}
            onPress={() => requests && addMutation.mutate(requests)}
          >
            Add
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
