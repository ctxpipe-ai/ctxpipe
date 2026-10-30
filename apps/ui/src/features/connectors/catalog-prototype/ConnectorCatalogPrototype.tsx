/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? The Connectors route mounts this in place of today's catalog
 * dialog. It turns the org's connections into entry states and starts a
 * setup through the route's own handlers; a variant only lays them out.
 */
import type { OrgConnectionListItem } from "../queries/org-connections"
import { CATALOG, entryState } from "./catalog-data"
import { type CatalogStartHandlers, useCatalogStart } from "./catalog-start"
import type { CatalogFacts, CatalogVariantKey } from "./prototype-variant"
import { VariantA } from "./VariantA"
import { VariantB } from "./VariantB"
import { VariantC } from "./VariantC"

export function ConnectorCatalogPrototype(props: {
  variant: Exclude<CatalogVariantKey, "current">
  facts: CatalogFacts | undefined
  orgSlug: string
  connections: readonly OrgConnectionListItem[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  start: CatalogStartHandlers
}) {
  const { run, pendingId, githubModal } = useCatalogStart({
    orgSlug: props.orgSlug,
    start: props.start,
    onFlowStarted: () => props.onOpenChange(false),
  })
  const facts = props.facts ?? { deployment: "hosted", health: {} }
  const variantProps = {
    entries: CATALOG.map((entry) => ({
      entry,
      state: entryState(entry, props.connections, facts),
    })),
    pendingId,
    onStart: run,
    onClose: () => props.onOpenChange(false),
  }
  return (
    <>
      {props.variant === "A" ? (
        <VariantA
          {...variantProps}
          isOpen={props.isOpen}
          onOpenChange={props.onOpenChange}
        />
      ) : null}
      {props.variant === "B" ? (
        <VariantB
          {...variantProps}
          isOpen={props.isOpen}
          onOpenChange={props.onOpenChange}
        />
      ) : null}
      {props.variant === "C" && props.isOpen ? (
        <VariantC {...variantProps} />
      ) : null}
      {githubModal}
    </>
  )
}
