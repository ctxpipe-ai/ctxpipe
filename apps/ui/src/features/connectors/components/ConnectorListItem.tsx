"use client"

import { IconChevronRight, IconDotsVertical } from "@tabler/icons-react"
import { type ReactNode, useContext, useState } from "react"
import { DisclosureStateContext } from "react-aria-components"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import { Disclosure, DisclosurePanel } from "@/components/ui/Disclosure"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Modal } from "@/components/ui/Modal"
import type { ConnectorHealth } from "../connectorHealth"
import { ConnectorHealthIndicator } from "./ConnectorHealthIndicator"

function ExpandTrigger({ name }: { name: string }) {
  const state = useContext(DisclosureStateContext)
  const isExpanded = state?.isExpanded ?? false
  return (
    <Button
      slot="trigger"
      variant="ghost"
      size="icon-sm"
      className="rounded-md"
      aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
    >
      <IconChevronRight
        aria-hidden
        className={`size-4 text-muted-foreground transition-transform duration-200 ${
          isExpanded ? "rotate-90" : ""
        }`}
      />
    </Button>
  )
}

function ConnectorRemoveMenu({
  ariaLabel,
  onRemove,
}: {
  ariaLabel: string
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <IconDotsVertical className="size-4" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          Remove connector
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConnectorRemoveDialog({
  name,
  pending,
  description,
  isOpen,
  onOpenChange,
  onConfirm,
}: {
  name: string
  pending: boolean
  description: ReactNode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <AlertDialog
        title={
          pending ? `Remove this ${name} setup?` : `Remove ${name} connector?`
        }
        variant="destructive"
        actionLabel={pending ? "Remove setup" : "Remove connector"}
        cancelLabel="Cancel"
        onAction={onConfirm}
      >
        {pending
          ? `This deletes the setup that is not finished, with its saved steps. To connect ${name} later, start again from Add connection.`
          : description}
      </AlertDialog>
    </Modal>
  )
}

export function ConnectorListItem({
  id,
  name,
  icon,
  health,
  remove,
  workspace,
  scope,
  syncRepository,
  actionLabel,
  onAction,
  defaultExpanded = false,
  children,
}: {
  id?: string
  name: string
  icon: ReactNode
  health: ConnectorHealth
  /**
   * Remove flow. A row with the health `setup_pending` is a draft: it shows
   * Remove and the step action on the row, in place of the menu.
   */
  remove: { description: ReactNode; onConfirm: () => void }
  workspace: ReactNode
  scope: ReactNode
  syncRepository: ReactNode
  actionLabel?: string
  onAction?: () => void
  defaultExpanded?: boolean
  children?: ReactNode
}) {
  const [removeOpen, setRemoveOpen] = useState(false)
  const pending = health === "setup_pending"
  const action = actionLabel && onAction ? { actionLabel, onAction } : null
  return (
    <>
      <Disclosure
        id={id}
        defaultExpanded={defaultExpanded}
        className="border-b border-white/[0.06]"
      >
        <div className="@container">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-3 sm:px-2">
            <span className="ctx-node h-9 w-9 shrink-0">{icon}</span>
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {name}
            </p>
            {pending ? (
              <div className="flex flex-wrap items-center gap-2 @max-2xl:order-last @max-2xl:w-full @max-2xl:pl-12">
                <ConnectorHealthIndicator health={health} />
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="quiet"
                    className="whitespace-nowrap"
                    aria-label={`Remove ${name} setup`}
                    onPress={() => setRemoveOpen(true)}
                  >
                    Remove
                  </Button>
                  {action ? (
                    <Button
                      variant="secondary"
                      className="whitespace-nowrap"
                      aria-label={`${action.actionLabel} for ${name}`}
                      onPress={action.onAction}
                    >
                      {action.actionLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <ConnectorHealthIndicator health={health} />
                <ConnectorRemoveMenu
                  ariaLabel={`${name} connector actions`}
                  onRemove={() => setRemoveOpen(true)}
                />
              </>
            )}
            <ExpandTrigger name={name} />
          </div>
        </div>
        <DisclosurePanel>
          <div className="space-y-4 px-1 pb-4 sm:px-2 sm:pl-[3.25rem]">
            {children}
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="mt-1 text-foreground">{workspace}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="mt-1 text-foreground">{scope}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">
                  Synchronised repository
                </dt>
                <dd className="mt-1 text-foreground">{syncRepository}</dd>
              </div>
            </dl>
            {action && !pending ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  className="text-sm text-teal-400 underline-offset-4 transition-colors hover:text-teal-300 hover:underline"
                  onClick={action.onAction}
                >
                  {action.actionLabel}
                </button>
              </div>
            ) : null}
          </div>
        </DisclosurePanel>
      </Disclosure>
      <ConnectorRemoveDialog
        name={name}
        pending={pending}
        description={remove.description}
        isOpen={removeOpen}
        onOpenChange={setRemoveOpen}
        onConfirm={remove.onConfirm}
      />
    </>
  )
}

export function connectorDash(value: string | null | undefined): string {
  return value?.trim() ? value : "—"
}

export function formatSyncRepositoryLine(
  target: {
    repositoryName: string
    branch: string
  } | null,
): ReactNode {
  if (!target) return "—"
  return (
    <>
      {target.repositoryName}
      <span className="text-muted-foreground"> · branch {target.branch}</span>
    </>
  )
}
