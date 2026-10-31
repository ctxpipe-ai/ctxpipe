import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { Heading } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"

import { ChooseWorkspacesStep } from "./ChooseWorkspacesStep"
import { sourceProviderLabel } from "./source-provider-ui"
import { useAddToWorkspaces } from "./useAddToWorkspaces"

/** "Add to a Workspace" from a connector: the Add to Workspaces step alone. */
export function AddToWorkspacesDialog(props: {
  orgSlug: string
  connectionId: string
  provider: SourceProvider
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { orgSlug, connectionId, provider, isOpen, onOpenChange } = props
  const adding = useAddToWorkspaces({
    orgSlug,
    provider,
    connectionId,
    onAdded: () => onOpenChange(false),
  })
  const close = () => {
    adding.reset()
    onOpenChange(false)
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? onOpenChange(true) : close())}
      isDismissable={!adding.isPending}
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
            value={adding.value}
            onChange={adding.setValue}
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="quiet" onPress={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!adding.canAdd}
            isPending={adding.isPending}
            onPress={adding.add}
          >
            Add
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
