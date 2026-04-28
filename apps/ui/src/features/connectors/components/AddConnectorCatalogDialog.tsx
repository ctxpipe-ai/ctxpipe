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
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">
              Add connection
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose a source to connect to this organization.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-none"
            aria-label="Close"
            onPress={() => onOpenChange(false)}
          >
            <IconX className="size-4 shrink-0" aria-hidden />
          </Button>
        </div>

        <ul className="space-y-3">{children}</ul>
      </div>
    </Modal>
  )
}
