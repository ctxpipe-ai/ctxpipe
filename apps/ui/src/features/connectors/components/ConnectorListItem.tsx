"use client"

import { IconDotsVertical, IconRefresh } from "@tabler/icons-react"
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import { Disclosure, DisclosurePanel } from "@/components/ui/Disclosure"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Modal, useIsModalOpen } from "@/components/ui/Modal"
import { Skeleton, SkeletonChain, SkeletonText } from "@/components/ui/Skeleton"

import { connectionAnchorId, scrollToConnection } from "../connectionAnchor"
import type { ConnectorHealth } from "../connectorHealth"
import { ConnectorHealthIndicator } from "./ConnectorHealthIndicator"

type ConnectorSyncAction = { start: () => void; isPending: boolean }

/**
 * The head of the tile opens and closes its details: the connector mark and
 * the name are one button, so there is no separate expand icon.
 */
function TileTrigger({
  name,
  icon,
  ref,
  describedBy,
}: {
  name: string
  icon: ReactNode
  ref: Ref<HTMLButtonElement>
  describedBy?: string
}) {
  return (
    <Button
      ref={ref}
      aria-describedby={describedBy}
      slot="trigger"
      variant="ghost"
      className="h-auto min-w-0 justify-start gap-3 rounded-md px-1.5 py-1.5 text-left"
    >
      <span aria-hidden className="ctx-node h-9 w-9 shrink-0">
        {icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {name}
      </span>
    </Button>
  )
}

function ConnectorActionsMenu({
  ariaLabel,
  sync,
  onRemove,
}: {
  ariaLabel: string
  sync?: ConnectorSyncAction
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
        {sync ? (
          <>
            <DropdownMenuItem disabled={sync.isPending} onSelect={sync.start}>
              <IconRefresh aria-hidden />
              Sync now
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
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
          ? `This deletes the ${name} connection and its access grant, with its saved setup. Files already committed to Git stay in place.`
          : description}
      </AlertDialog>
    </Modal>
  )
}

export function ConnectorListItem({
  connectionId,
  marked = false,
  name,
  icon,
  health,
  remove,
  workspace,
  usedIn,
  sync,
  actionLabel,
  onAction,
  defaultExpanded = false,
  children,
}: {
  /** The card's connection anchor (`connectionAnchorId`) comes from it. */
  connectionId: string
  /**
   * The catalog Fix marks the card for a moment. When no modal is open, the
   * card scrolls into view and its expand control gets the focus.
   */
  marked?: boolean
  name: string
  icon: ReactNode
  health: ConnectorHealth
  /**
   * Remove flow. A row with the health `setup_pending` is a draft: it shows
   * Remove and the step action on the row, in place of the menu.
   */
  remove: { description: ReactNode; onConfirm: () => void }
  /**
   * The provider account of the connection, for example the Linear workspace
   * or the GitHub organization. The row labels it "Account", so that it is
   * not read as a ctxpipe Workspace.
   */
  workspace: ReactNode
  /**
   * The "Used in" block: the Workspaces that use this connection. Each
   * provider card gives `<ConnectorUsedIn …/>`.
   */
  usedIn?: ReactNode
  /** "Sync now" in the actions menu; from `useConnectorSync`. */
  sync?: ConnectorSyncAction
  actionLabel?: string
  onAction?: () => void
  defaultExpanded?: boolean
  children?: ReactNode
}) {
  const [removeOpen, setRemoveOpen] = useState(false)
  const pending = health === "setup_pending"
  const action = actionLabel && onAction ? { actionLabel, onAction } : null
  const triggerRef = useRef<HTMLButtonElement>(null)
  const markedHintId = useId()
  const modalOpen = useIsModalOpen()
  useEffect(() => {
    if (!marked || modalOpen) return
    // A closed modal gives the focus back in the next frame; this frame
    // comes after it.
    const frame = requestAnimationFrame(() => {
      scrollToConnection(connectionId)
      triggerRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [marked, modalOpen, connectionId])
  return (
    <>
      <Disclosure
        defaultExpanded={defaultExpanded}
        className={`min-w-0 border bg-zinc-900/40 wrap-anywhere transition-colors ${
          marked
            ? "border-teal-400/40 bg-teal-400/10 outline-2 -outline-offset-2 outline-teal-400"
            : "border-white/[0.08]"
        }`}
      >
        {marked ? (
          <span id={markedHintId} className="sr-only">
            Needs your attention
          </span>
        ) : null}
        {/* The Disclosure keeps its own `id` off the DOM: the anchor is here. */}
        <div id={connectionAnchorId(connectionId)} className="@container">
          <div className={tileHeadClassName}>
            <TileTrigger
              name={name}
              icon={icon}
              ref={triggerRef}
              describedBy={marked ? markedHintId : undefined}
            />
            {/*
             * One column for the status of every tile, so the dots align. A
             * narrow tile puts the status under the name.
             */}
            <div className={tileStatusClassName}>
              <ConnectorHealthIndicator health={health} />
            </div>
            {pending ? (
              <span aria-hidden className={`size-8 ${tileMenuClassName}`} />
            ) : (
              <span className={tileMenuClassName}>
                <ConnectorActionsMenu
                  ariaLabel={`${name} connector actions`}
                  sync={sync}
                  onRemove={() => setRemoveOpen(true)}
                />
              </span>
            )}
          </div>
          {pending ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-3 py-2.5">
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
          ) : null}
        </div>
        <DisclosurePanel>
          <div className="space-y-4 border-t border-white/[0.06] px-3 py-4 sm:pl-14">
            {children}
            {usedIn}
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Account</dt>
                <dd className="mt-1 text-foreground">{workspace}</dd>
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

/**
 * The head of a tile: the trigger, the status column and the menu. Below a
 * container width of 28rem, the status moves to a second row under the name
 * (the trigger padding, the mark and the gap: 3.375rem).
 */
const tileHeadClassName =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 p-2 @max-md:grid-cols-[minmax(0,1fr)_auto]"
const tileStatusClassName =
  "flex w-36 @max-md:col-start-1 @max-md:row-start-2 @max-md:w-auto @max-md:pb-1.5 @max-md:pl-13.5"
const tileMenuClassName = "@max-md:col-start-2 @max-md:row-start-1"

export function connectorDash(value: string | null | undefined): string {
  return value?.trim() ? value : "—"
}

/** The collapsed `ConnectorListItem` tile while the connections load. */
export function ConnectorListItemSkeleton() {
  return (
    <div className="@container rounded-md border border-white/[0.08] bg-zinc-900/40">
      <div className={tileHeadClassName}>
        <div className="flex min-w-0 items-center gap-3 px-1.5 py-1.5">
          <Skeleton className="size-9 shrink-0" />
          <SkeletonText
            className="min-w-0 flex-1 text-sm"
            boneClassName="w-32"
          />
        </div>
        <SkeletonText
          className={`text-xs ${tileStatusClassName}`}
          boneClassName="w-20"
        />
        <Skeleton className={`size-8 ${tileMenuClassName}`} />
      </div>
    </div>
  )
}

export function ConnectorListSkeleton() {
  return (
    <SkeletonChain id="connectors">
      <div aria-busy className="flex flex-col gap-2">
        <span className="sr-only">Loading connectors</span>
        <ConnectorListItemSkeleton />
        <ConnectorListItemSkeleton />
        <ConnectorListItemSkeleton />
      </div>
    </SkeletonChain>
  )
}
