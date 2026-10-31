"use client"

import HyperDX from "@hyperdx/browser"
import { IconX } from "@tabler/icons-react"
import { useState } from "react"
import {
  Dialog,
  Heading,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { focusRing } from "@/lib/react-aria-utils"

import { ConnectorHealthIndicator } from "../components/ConnectorHealthIndicator"
import type { OrgConnectionListItem } from "../queries/org-connections"
import {
  type CatalogRow,
  type CatalogViewId,
  catalogRows,
  catalogViews,
  groupName,
  rowsInView,
  statusChip,
} from "./catalog-state"
import type {
  AvailableConnectorEntry,
  ConnectorEntry,
  SetupRequest,
} from "./registry"
import { useConnectorStart } from "./useConnectorStart"

type ConnectorCatalogDialogProps = {
  orgSlug: string
  /** The org's connections, from the connectors list. */
  connections: readonly OrgConnectionListItem[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** Opens the setup that a start gives. The catalog is closed then. */
  onOpenSetup: (setup: SetupRequest) => void
  /**
   * Takes the user to the card of a connection that needs a fix. The
   * catalog is closed then.
   */
  onFix: (connectionId: string) => void
}

/**
 * "Add connection": one row for each connector of the registry, with one
 * state for each provider. The left pane selects a view; a search looks in
 * every view.
 */
export function ConnectorCatalogDialog({
  isOpen,
  onOpenChange,
  ...props
}: ConnectorCatalogDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      size="wide"
    >
      <CatalogContent {...props} onClose={() => onOpenChange(false)} />
    </Modal>
  )
}

/** In the modal, so that each open starts on All with an empty search. */
function CatalogContent(
  props: Omit<ConnectorCatalogDialogProps, "isOpen" | "onOpenChange"> & {
    onClose: () => void
  },
) {
  const [query, setQuery] = useState("")
  const [view, setView] = useState<CatalogViewId>("all")
  const { start, pendingId } = useConnectorStart({
    orgSlug: props.orgSlug,
    onOpenSetup: props.onOpenSetup,
    closeCatalog: props.onClose,
  })
  const rows = catalogRows(props.connections)
  const views = catalogViews(rows)
  const shown = rowsInView(rows, view, query)
  const searching = query.trim().length > 0

  return (
    <Dialog className="flex h-[min(80vh,36rem)] flex-col outline-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-white/[0.06] px-5 py-4">
        <Heading
          slot="title"
          className="text-lg font-medium tracking-tight text-foreground"
        >
          Add connection
        </Heading>
        <SearchField
          aria-label="Search connectors"
          placeholder="Search connectors"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the catalog opens to find a connector
          autoFocus
          className="order-last w-full sm:order-none sm:ml-auto sm:w-64"
          value={query}
          onChange={(value) => {
            setQuery(value)
            // A search shows matches from every group.
            if (value.trim()) setView("all")
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          className="ml-auto sm:ml-0"
          onPress={props.onClose}
        >
          <IconX className="size-4 shrink-0" aria-hidden />
        </Button>
      </div>

      <Tabs
        orientation="vertical"
        selectedKey={view}
        onSelectionChange={(key) => setView(key as CatalogViewId)}
        className="flex min-h-0 flex-1 flex-col sm:flex-row"
      >
        <TabList
          aria-label="Connector views"
          className="flex shrink-0 flex-col gap-0.5 overflow-y-auto border-white/[0.06] p-2 max-sm:max-h-36 max-sm:border-b sm:w-52 sm:border-r"
        >
          {views.map((item) => (
            <Tab
              key={item.id}
              id={item.id}
              aria-label={`${item.name}, ${item.count}`}
              className={({ isSelected, isFocusVisible }) =>
                `${focusRing({ isFocusVisible })} flex cursor-default items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  isSelected
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                } ${item.id === "connected" ? "mb-2" : ""} ${
                  item.id === "coming_soon" ? "mt-2" : ""
                }`
              }
            >
              {item.name}
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {item.count}
              </span>
            </Tab>
          ))}
        </TabList>
        {views.map((item) => (
          <TabPanel
            key={item.id}
            id={item.id}
            className="min-h-0 flex-1 overflow-y-auto px-5 py-2 outline-0"
          >
            {view === "coming_soon" && !searching ? (
              <p className="py-2 text-sm text-muted-foreground">
                Tell us which one you need first.
              </p>
            ) : null}
            {shown.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {searching
                  ? `No connector matches “${query.trim()}”.`
                  : "Nothing is connected yet."}
              </p>
            ) : (
              <ul aria-label={searching ? "Search results" : item.name}>
                {shown.map((row) => (
                  <CatalogRowItem
                    key={row.entry.id}
                    row={row}
                    showGroup={
                      searching || view === "all" || view === "connected"
                    }
                    pending={pendingId === row.entry.id}
                    onStart={start}
                    onFix={(connectionId) => {
                      props.onClose()
                      props.onFix(connectionId)
                    }}
                  />
                ))}
              </ul>
            )}
          </TabPanel>
        ))}
      </Tabs>
    </Dialog>
  )
}

function CatalogRowItem({
  row,
  showGroup,
  pending,
  onStart,
  onFix,
}: {
  row: CatalogRow
  showGroup: boolean
  pending: boolean
  onStart: (entry: AvailableConnectorEntry) => void
  onFix: (connectionId: string) => void
}) {
  const { entry } = row
  const soon = row.kind === "coming_soon"
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] py-3 last:border-b-0">
      <span className="ctx-node size-9 shrink-0" aria-hidden>
        <entry.Mark
          className={`size-5 ${soon ? "text-muted-foreground" : "text-foreground"}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-3 text-sm">
          <span
            className={`font-medium ${soon ? "text-muted-foreground" : "text-foreground"}`}
          >
            {entry.name}
          </span>
          {showGroup ? (
            <span className="text-xs text-muted-foreground">
              {groupName(entry.group)}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {entry.description}
        </p>
      </div>
      <RowStateAndActions
        row={row}
        pending={pending}
        onStart={onStart}
        onFix={onFix}
      />
    </li>
  )
}

/** The state of the provider and its actions, for each availability. */
function RowStateAndActions({
  row,
  pending,
  onStart,
  onFix,
}: {
  row: CatalogRow
  pending: boolean
  onStart: (entry: AvailableConnectorEntry) => void
  onFix: (connectionId: string) => void
}) {
  switch (row.kind) {
    case "coming_soon":
      return (
        <>
          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-zinc-500" />
            Coming soon
          </span>
          <div className="flex shrink-0 justify-end gap-1 sm:w-44">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Ask for ${row.entry.name}`}
              onPress={() => askFor(row.entry.id, row.entry.name)}
            >
              Ask for it
            </Button>
          </div>
        </>
      )
    case "available": {
      const { entry, fixConnectionId } = row
      const chip = statusChip(row)
      return (
        <>
          {chip ? (
            <ConnectorHealthIndicator health={chip.health} label={chip.label} />
          ) : null}
          <div className="flex shrink-0 justify-end gap-1 sm:w-44">
            {fixConnectionId ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Fix ${entry.name}`}
                onPress={() => onFix(fixConnectionId)}
              >
                Fix
              </Button>
            ) : null}
            {row.count > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                isPending={pending}
                aria-label={`Add another ${entry.name} connection`}
                onPress={() => onStart(entry)}
              >
                Add another
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                isPending={pending}
                aria-label={`Connect ${entry.name}`}
                onPress={() => onStart(entry)}
              >
                Connect
              </Button>
            )}
          </div>
        </>
      )
    }
    default: {
      const unhandled: never = row
      return unhandled
    }
  }
}

/**
 * "Ask for it": a product event with the provider. HyperDX adds the org and
 * the user to each browser event (`setHyperDxGlobalAttributes`).
 */
function askFor(connector: ConnectorEntry["id"], name: string) {
  HyperDX.addAction("connector_request", { connector })
  toast.success(`Thanks. We noted that you want ${name}.`)
}
