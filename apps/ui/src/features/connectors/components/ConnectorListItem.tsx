"use client"

import { IconChevronRight, IconDotsVertical } from "@tabler/icons-react"
import { type ReactNode, useContext } from "react"
import { DisclosureStateContext } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Disclosure, DisclosurePanel } from "@/components/ui/Disclosure"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
      className="rounded-none"
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

export function ConnectorRemoveMenu({
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
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
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

export function ConnectorListItem({
  id,
  name,
  icon,
  health,
  menu,
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
  menu: ReactNode
  workspace: ReactNode
  scope: ReactNode
  syncRepository: ReactNode
  actionLabel?: string
  onAction?: () => void
  defaultExpanded?: boolean
  children?: ReactNode
}) {
  return (
    <Disclosure
      id={id}
      defaultExpanded={defaultExpanded}
      className="border-b border-white/[0.06]"
    >
      <div className="flex items-center gap-3 px-1 py-3 sm:px-2">
        <span className="ctx-node h-9 w-9 shrink-0">{icon}</span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {name}
        </p>
        <ConnectorHealthIndicator health={health} />
        {menu}
        <ExpandTrigger name={name} />
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
              <dt className="text-muted-foreground">Synchronised repository</dt>
              <dd className="mt-1 text-foreground">{syncRepository}</dd>
            </div>
          </dl>
          {actionLabel && onAction ? (
            <div className="flex justify-end">
              <button
                type="button"
                className="text-sm text-teal-400 underline-offset-4 transition-colors hover:text-teal-300 hover:underline"
                onClick={onAction}
              >
                {actionLabel}
              </button>
            </div>
          ) : null}
        </div>
      </DisclosurePanel>
    </Disclosure>
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
