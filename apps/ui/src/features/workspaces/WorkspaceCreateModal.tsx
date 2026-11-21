import { IconX } from "@tabler/icons-react"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"

import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

/**
 * Opens `WorkspaceCreateForm` in a modal, so the user can create a Workspace
 * from any page, for example from the side navigation.
 */
export function WorkspaceCreateModal(props: {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** See `WorkspaceCreateForm`. */
  onDone?: () => void
}) {
  const { orgSlug, isOpen, onOpenChange, onDone } = props

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      size="medium"
      placement="top"
    >
      <Dialog className="pr-12">
        <Button
          slot="close"
          variant="quiet"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label="Close"
        >
          <IconX className="size-4 text-muted-foreground" aria-hidden />
        </Button>
        {/* "Open Workspace" changes the page, and that closes this modal. */}
        <WorkspaceCreateForm orgSlug={orgSlug} onDone={onDone} />
      </Dialog>
    </Modal>
  )
}
