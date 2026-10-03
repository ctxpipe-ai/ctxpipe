import { IconX } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

export function WorkspaceCreateModal(props: {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { orgSlug, isOpen, onOpenChange } = props
  const navigate = useNavigate()

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
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label="Close"
        >
          <IconX className="size-4 text-muted-foreground" aria-hidden />
        </Button>
        <WorkspaceCreateForm
          orgSlug={orgSlug}
          onCreated={(slug) => {
            onOpenChange(false)
            void navigate({
              to: "/$orgSlug/ws/$workspaceSlug",
              params: { orgSlug, workspaceSlug: slug },
            })
          }}
        />
      </Dialog>
    </Modal>
  )
}
