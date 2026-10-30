/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? Variant C is a full page in place of the Connectors list, with
 * a back link. Each group is a section with a short intro on the left and
 * full rows on the right. A summary line names what the org has connected.
 * All coming-soon connectors are in one section at the end.
 */
import { IconArrowLeft } from "@tabler/icons-react"
import { type ReactNode, useState } from "react"

import { Button } from "@/components/ui/Button"
import { SearchField } from "@/components/ui/SearchField"

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

export function VariantC(props: CatalogVariantProps) {
  const [filter, setFilter] = useState("")
  const shown = props.entries.filter(({ entry }) =>
    matchesFilter(entry, filter),
  )
  const live = shown.filter(({ state }) => state.kind !== "coming_soon")
  const soon = shown.filter(({ state }) => state.kind === "coming_soon")
  const connected = props.entries.filter(
    ({ state }) => connectionCount(state) > 0,
  )
  const attention = connected.filter(
    ({ state }) => state.reconnect + state.setupPending > 0,
  ).length

  return (
    <div className="flex flex-col">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          onPress={props.onClose}
        >
          <IconArrowLeft className="size-4" aria-hidden />
          Connectors
        </Button>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-medium tracking-tight text-foreground">
            Add connection
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {connected.length > 0 ? (
              <>
                {connected.length} of {props.entries.length} connectors are in
                use
                {attention > 0 ? (
                  <>
                    {" "}
                    ·{" "}
                    <span className="text-amber-400">
                      {attention} need{attention === 1 ? "s" : ""} you
                    </span>
                  </>
                ) : null}
                .
              </>
            ) : (
              "Choose a source to connect to this organization."
            )}
          </p>
        </div>
        <SearchField
          aria-label="Search connectors"
          placeholder="Search connectors"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the catalog opens to type a filter
          autoFocus
          className="w-full sm:w-72"
          value={filter}
          onChange={setFilter}
        />
      </div>

      <div className="mt-10 flex flex-col gap-10">
        {CATALOG_GROUPS.map((group) => {
          const inGroup = live.filter(({ entry }) => entry.group === group.id)
          if (inGroup.length === 0) return null
          return (
            <Section key={group.id} name={group.name} about={group.about}>
              {inGroup.map(({ entry, state }) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  state={state}
                  pending={props.pendingId === entry.id}
                  onStart={() => props.onStart(entry.id)}
                />
              ))}
            </Section>
          )
        })}
        {soon.length > 0 ? (
          <Section
            name="Coming soon"
            about="Tell us which one you need first. The most-asked ships first."
          >
            {soon.map(({ entry, state }) => (
              <Row
                key={entry.id}
                entry={entry}
                state={state}
                pending={false}
                onStart={() => {}}
              />
            ))}
          </Section>
        ) : null}
        {shown.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            <p>No connector matches “{filter.trim()}”.</p>
            <p className="mt-2">
              <AskForIt name={filter.trim()} label="Ask for this connector" />
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Section(props: { name: string; about: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[13rem_1fr] md:gap-8">
      <div>
        <h2 className="text-sm font-medium text-foreground">{props.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{props.about}</p>
      </div>
      <ul className="border-t border-white/[0.06]">{props.children}</ul>
    </section>
  )
}

function Row(props: {
  entry: CatalogEntry
  state: EntryState
  pending: boolean
  onStart: () => void
}) {
  const { entry, state } = props
  const dim = state.kind !== "available"
  const count = connectionCount(state)
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] py-4 last:border-b-0">
      <span className="ctx-node size-10">
        <entry.Mark
          className={`size-5 ${dim ? "text-muted-foreground" : "text-foreground"}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-medium ${dim ? "text-muted-foreground" : "text-foreground"}`}
        >
          {entry.name}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {entry.description}
        </p>
        {state.kind === "not_on_hosted" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {HOSTED_PENDING_REASON}
          </p>
        ) : null}
      </div>
      <CatalogStatus state={state} />
      <div className="flex w-28 shrink-0 justify-end">
        {canStart(state) ? (
          <Button
            variant={count > 0 ? "ghost" : "secondary"}
            size="sm"
            isPending={props.pending}
            aria-label={`${count > 0 ? "Add another" : "Connect"} ${entry.name}`}
            onPress={props.onStart}
          >
            {count > 0 ? "Add another" : "Connect"}
          </Button>
        ) : state.kind === "coming_soon" ? (
          <AskForIt name={entry.name} />
        ) : null}
      </div>
    </li>
  )
}
