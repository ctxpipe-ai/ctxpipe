/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? Variant B is a two-pane dialog with a fixed size. The left
 * pane lists the groups with counts, plus "Connected" and "Coming soon"
 * views. The right pane shows one row for each connector, with an explicit
 * action. A filter searches all groups.
 */
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

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { focusVisibleClassName } from "@/lib/focus-styles"

import {
  CATALOG_GROUPS,
  type CatalogEntry,
  connectionCount,
  type EntryState,
  HOSTED_PENDING_REASON,
  matchesFilter,
} from "./catalog-data"
import {
  AskForIt,
  CatalogStatus,
  type CatalogVariantProps,
  canStart,
} from "./CatalogParts"

type ViewKey =
  | "all"
  | "connected"
  | "soon"
  | (typeof CATALOG_GROUPS)[number]["id"]

export function VariantB(
  props: CatalogVariantProps & {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
  },
) {
  const [filter, setFilter] = useState("")
  const [view, setView] = useState<ViewKey>("all")
  const { entries } = props
  const inView = (key: ViewKey) =>
    entries.filter(({ entry, state }) => {
      if (key === "all") return true
      if (key === "connected") return connectionCount(state) > 0
      if (key === "soon") return state.kind === "coming_soon"
      return entry.group === key
    })
  const views: { key: ViewKey; name: string }[] = [
    { key: "all", name: "All connectors" },
    { key: "connected", name: "Connected" },
    ...CATALOG_GROUPS.map((group) => ({ key: group.id, name: group.name })),
    { key: "soon", name: "Coming soon" },
  ]
  const shown = inView(view).filter(({ entry }) => matchesFilter(entry, filter))
  const group = CATALOG_GROUPS.find((item) => item.id === view)

  return (
    <Modal
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        props.onOpenChange(open)
        if (!open) {
          setFilter("")
          setView("all")
        }
      }}
      isDismissable
      size="wide"
    >
      <Dialog
        className="flex h-[min(80vh,38rem)] flex-col outline-0"
        aria-label="Add connection"
      >
        <div className="flex items-center gap-4 border-b border-white/[0.06] px-5 py-4">
          <Heading
            slot="title"
            className="text-lg font-medium tracking-tight text-foreground"
          >
            Add connection
          </Heading>
          <SearchField
            aria-label="Search connectors"
            placeholder="Search connectors"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the catalog opens to type a filter
            autoFocus
            className="ml-auto w-64"
            value={filter}
            onChange={(value) => {
              setFilter(value)
              // A search looks in every group.
              if (value.trim()) setView("all")
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onPress={props.onClose}
          >
            <IconX className="size-4 shrink-0" aria-hidden />
          </Button>
        </div>

        <Tabs
          orientation="vertical"
          selectedKey={view}
          onSelectionChange={(key) => setView(key as ViewKey)}
          className="flex min-h-0 flex-1"
        >
          <TabList
            aria-label="Connector groups"
            className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/[0.06] p-2"
          >
            {views.map((item) => (
              <Tab
                key={item.key}
                id={item.key}
                className={({ isSelected }) =>
                  `flex cursor-default items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors ${focusVisibleClassName} ${
                    isSelected
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                  } ${item.key === "connected" ? "mb-2" : ""} ${
                    item.key === "soon" ? "mt-2" : ""
                  }`
                }
              >
                {item.name}
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {inView(item.key).length}
                </span>
              </Tab>
            ))}
          </TabList>
          {views.map((item) => (
            <TabPanel
              key={item.key}
              id={item.key}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-0"
            >
              {group ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  {group.about}
                </p>
              ) : null}
              {view === "soon" ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  Tell us which one you need first.
                </p>
              ) : null}
              {shown.length === 0 ? (
                <div className="py-6 text-sm text-muted-foreground">
                  {filter.trim() ? (
                    <>
                      <p>No connector matches “{filter.trim()}”.</p>
                      <p className="mt-2">
                        <AskForIt
                          name={filter.trim()}
                          label="Ask for this connector"
                        />
                      </p>
                    </>
                  ) : (
                    <p>Nothing is connected yet.</p>
                  )}
                </div>
              ) : (
                <ul>
                  {shown.map(({ entry, state }) => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      state={state}
                      showGroup={view === "all" || view === "connected"}
                      pending={props.pendingId === entry.id}
                      onStart={() => props.onStart(entry.id)}
                      onFix={() => {
                        props.onOpenChange(false)
                        // Let the dialog close before the page scrolls.
                        window.setTimeout(() => showCard(entry.name), 250)
                      }}
                    />
                  ))}
                </ul>
              )}
            </TabPanel>
          ))}
        </Tabs>
      </Dialog>
    </Modal>
  )
}

/**
 * Fix: the catalog shows one state for each provider; the detail of each
 * connection is on its card. Scroll to the first card of the provider and
 * mark it for a moment. (Prototype: the real build names the connection
 * that needs the fix, and can open its setup when only one does.)
 */
function showCard(name: string) {
  // A card with an unfinished setup has no actions menu: find its name.
  const start =
    document.querySelector(`[aria-label="${name} connector actions"]`) ??
    [...document.querySelectorAll("main p")].find(
      (node) => node.textContent?.trim() === name,
    )
  let card = start?.parentElement ?? null
  while (card && !card.className.includes("border-b")) card = card.parentElement
  if (!card) return
  card.scrollIntoView({ block: "center", behavior: "smooth" })
  const mark = ["rounded-lg", "bg-amber-400/10", "ring-1", "ring-amber-400/60"]
  card.classList.add(...mark)
  window.setTimeout(() => card?.classList.remove(...mark), 2400)
}

function Row(props: {
  entry: CatalogEntry
  state: EntryState
  showGroup: boolean
  pending: boolean
  onStart: () => void
  onFix: () => void
}) {
  const { entry, state } = props
  const needsFix = state.reconnect > 0 || state.setupPending > 0
  const dim = state.kind !== "available"
  const groupName = CATALOG_GROUPS.find((g) => g.id === entry.group)?.name
  return (
    <li className="flex items-center gap-3 border-b border-white/[0.06] py-3 last:border-b-0">
      <span className="ctx-node size-9">
        <entry.Mark
          className={`size-5 ${dim ? "text-muted-foreground" : "text-foreground"}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-3 text-sm">
          <span
            className={`font-medium ${dim ? "text-muted-foreground" : "text-foreground"}`}
          >
            {entry.name}
          </span>
          {props.showGroup ? (
            <span className="text-xs text-muted-foreground">{groupName}</span>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {state.kind === "not_on_hosted"
            ? HOSTED_PENDING_REASON
            : entry.description}
        </p>
      </div>
      <CatalogStatus state={state} />
      <div className="flex w-44 shrink-0 justify-end gap-1">
        {needsFix ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Fix ${entry.name}`}
            onPress={props.onFix}
          >
            Fix
          </Button>
        ) : null}
        {canStart(state) ? (
          <Button
            variant={connectionCount(state) > 0 ? "ghost" : "secondary"}
            size="sm"
            isPending={props.pending}
            aria-label={`${connectionCount(state) > 0 ? "Add another" : "Connect"} ${entry.name}`}
            onPress={props.onStart}
          >
            {connectionCount(state) > 0 ? "Add another" : "Connect"}
          </Button>
        ) : state.kind === "coming_soon" ? (
          <AskForIt name={entry.name} />
        ) : null}
      </div>
    </li>
  )
}
