"use client"

import { IconX } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { ConfluenceMark } from "./ConfluenceMark"

type AddConnectorCatalogDialogProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onPickConfluence: () => void
}

export function AddConnectorCatalogDialog({
  isOpen,
  onOpenChange,
  onPickConfluence,
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

        <ul className="space-y-3">
          <li>
            <button
              type="button"
              className="flex w-full items-start gap-4 rounded-none border border-zinc-800 bg-zinc-900/40 p-4 text-left outline-none transition hover:border-zinc-700 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-primary/50"
              onClick={() => {
                onPickConfluence()
                onOpenChange(false)
              }}
            >
              <ConfluenceMark className="size-12 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium text-zinc-100">
                  Atlassian Confluence
                </span>
                <span className="mt-1 block text-sm text-zinc-400">
                  Sync spaces and pages from Confluence into ctxpipe and your
                  linked Git repositories.
                </span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </Modal>
  )
}
