import { IconPencil } from "@tabler/icons-react"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { RenameConversationModal } from "@/features/chat/components/RenameConversationModal"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { renameConversation } from "./queries"

/** The conversation title in the chat header. Pressing it opens the rename dialog. */
export function ConversationTitleButton(props: {
  orgSlug: string
  conversationId: string
  name: string
  onRenamed: (name: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const rename = useMutation({
    mutationFn: (name: string) =>
      renameConversation(props.orgSlug, props.conversationId, name),
    onSuccess: (updated) => {
      props.onRenamed(updated.name)
      setIsOpen(false)
    },
  })
  const close = () => {
    if (rename.isPending) return
    rename.reset()
    setIsOpen(false)
  }

  return (
    <>
      <RACButton
        aria-label={`Rename conversation: ${props.name}`}
        onPress={() => setIsOpen(true)}
        className={cn(
          "group/title inline-flex min-w-0 items-center gap-1.5 rounded-md text-left",
          "hover:text-teal-400",
          focusVisibleClassName,
        )}
      >
        <span className="min-w-0 truncate">{props.name}</span>
        <IconPencil
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
        />
      </RACButton>
      <Modal
        isOpen={isOpen}
        isDismissable={!rename.isPending}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <Dialog aria-label="Rename conversation" className="p-0">
          <RenameConversationModal
            conversationName={props.name}
            onClose={close}
            onSubmit={(name) => rename.mutate(name)}
            isPending={rename.isPending}
            error={rename.error?.message}
          />
        </Dialog>
      </Modal>
    </>
  )
}
