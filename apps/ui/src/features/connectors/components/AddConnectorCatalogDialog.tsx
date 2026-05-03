"use client"

import { IconX } from "@tabler/icons-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"

type AddConnectorCatalogDialogProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** One entry per source (e.g. `AddConfluenceConnectorButton` wrapped in `<li>`). */
  children: ReactNode
}

export function AddConnectorCatalogDialog({
  isOpen,
  onOpenChange,
  children,
}: AddConnectorCatalogDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      size="wide"
    >
      <div className="px-6 py-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">
              Add connection
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Choose a source to connect to this organization.
            </p>
          </div>
          <Button variant="ghost" onPress={() => onOpenChange(false)}>
            <IconX className="size-4 shrink-0" aria-hidden />
            Close
          </Button>
        </div>

        <ul className="space-y-3">{children}</ul>
      </div>
    </Modal>
  )
}
