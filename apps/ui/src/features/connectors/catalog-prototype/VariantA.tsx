/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? Variant A keeps the dialog, makes it wider, and puts a filter
 * on top. Groups have a heading and a grid of compact tiles. A coming-soon
 * tile stays in its group, dimmed.
 */
import { IconX } from "@tabler/icons-react"
import { useState } from "react"
import { Dialog, Heading, Button as RACButton } from "react-aria-components"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { Spinner } from "@/components/ui/spinner"
import { focusVisibleClassName } from "@/lib/focus-styles"

import {
  CATALOG_GROUPS,
  type CatalogEntry,
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

export function VariantA(
  props: CatalogVariantProps & {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
  },
) {
  const [filter, setFilter] = useState("")
  const shown = props.entries.filter(({ entry }) =>
    matchesFilter(entry, filter),
  )
  return (
    <Modal
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        props.onOpenChange(open)
        if (!open) setFilter("")
      }}
      isDismissable
      placement="top"
      className="max-w-[min(94vw,52rem)]"
    >
      <Dialog className="p-6 outline-0" aria-label="Add connection">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <Heading
              slot="title"
              className="text-lg font-medium tracking-tight text-foreground"
            >
              Add connection
            </Heading>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose a source to connect to this organization.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onPress={props.onClose}
          >
            <IconX className="size-4 shrink-0" aria-hidden />
          </Button>
        </div>

        <SearchField
          aria-label="Filter connectors"
          placeholder="Filter connectors"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the catalog opens to type a filter
          autoFocus
          value={filter}
          onChange={setFilter}
        />

        <div className="mt-6 space-y-6">
          {CATALOG_GROUPS.map((group) => {
            const inGroup = shown.filter(
              ({ entry }) => entry.group === group.id,
            )
            if (inGroup.length === 0) return null
            return (
              <section key={group.id} aria-labelledby={`a-${group.id}`}>
                <h3 id={`a-${group.id}`} className="ctx-label mb-2">
                  {group.name}
                </h3>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {inGroup.map(({ entry, state }) => (
                    <li key={entry.id}>
                      <Tile
                        entry={entry}
                        state={state}
                        pending={props.pendingId === entry.id}
                        onStart={() => props.onStart(entry.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          {shown.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              <p>No connector matches “{filter.trim()}”.</p>
              <p className="mt-2">
                <AskForIt name={filter.trim()} label="Ask for this connector" />
              </p>
            </div>
          ) : null}
        </div>
      </Dialog>
    </Modal>
  )
}

function Tile(props: {
  entry: CatalogEntry
  state: EntryState
  pending: boolean
  onStart: () => void
}) {
  const { entry, state } = props
  const dim = state.kind !== "available"
  const body = (
    <>
      <span
        className={`ctx-node size-9 transition-colors ${
          dim ? "" : "group-hover:border-teal-400/60 group-hover:bg-teal-400/5"
        }`}
      >
        <entry.Mark
          className={`size-5 ${dim ? "text-muted-foreground" : "text-foreground"}`}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`flex items-center gap-2 text-sm font-medium ${
            dim ? "text-muted-foreground" : "text-foreground"
          }`}
        >
          {entry.name}
          {props.pending ? (
            <Spinner className="size-3.5 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
        <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {state.kind === "not_on_hosted"
            ? HOSTED_PENDING_REASON
            : entry.description}
        </span>
        <span className="mt-1 flex min-h-4 items-center gap-3">
          <CatalogStatus state={state} />
          {state.kind === "coming_soon" ? <AskForIt name={entry.name} /> : null}
        </span>
      </span>
    </>
  )
  const frame =
    "group flex h-full w-full items-start gap-3 rounded-md border p-3 text-left"
  if (!canStart(state)) {
    return (
      <div className={`${frame} border-dashed border-white/10`}>{body}</div>
    )
  }
  return (
    <RACButton
      className={`${frame} border-border bg-card/40 transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] disabled:cursor-wait ${focusVisibleClassName}`}
      isDisabled={props.pending}
      onPress={props.onStart}
    >
      {body}
    </RACButton>
  )
}
