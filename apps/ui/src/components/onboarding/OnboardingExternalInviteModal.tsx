"use client"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"

type OnboardingExternalInviteModalProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  pendingExternalRecipients: string[]
  onCancel: () => void
  onConfirmSend: () => void
}

export function OnboardingExternalInviteModal({
  isOpen,
  onOpenChange,
  pendingExternalRecipients,
  onCancel,
  onConfirmSend,
}: OnboardingExternalInviteModalProps) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Dialog role="alertdialog">
        {({ close }) => (
          <div className="rounded-none bg-zinc-950/95 p-6">
            <h2 className="mb-3 text-xl font-semibold text-zinc-100">
              Invite external users?
            </h2>
            <p className="text-zinc-300">
              Invite external users ({pendingExternalRecipients.join(", ")})?
              They will receive access to your organisations engineering
              knowledge via this app and MCP.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="ghost"
                className="rounded-none text-zinc-400 hover:text-zinc-200"
                onPress={() => {
                  onCancel()
                  close()
                }}
              >
                Cancel
              </Button>
              <Button
                className="rounded-none bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                onPress={() => {
                  onConfirmSend()
                  close()
                }}
              >
                Send invites
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Modal>
  )
}
