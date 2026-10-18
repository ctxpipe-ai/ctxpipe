import {
  type ConfluenceSourceScope,
  confluenceSourceScopeSchema,
} from "backend/domain/workspace-sources/providers/confluence"
import { useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConfluenceMark } from "@/features/connectors/components/ConfluenceMark"
import { SpacePageTree } from "@/features/connectors/SpacePageTree"
import type { SpaceScopeItem } from "@/features/connectors/types"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { scopeLimitMessage } from "./ScopeLimitAlert"

/** The tree selection of a source scope. A bad or empty scope starts empty. */
export function confluenceScopeToSpaceItems(
  scope: Record<string, unknown>,
): SpaceScopeItem[] {
  const parsed = confluenceSourceScopeSchema.safeParse(scope)
  if (!parsed.success) return []
  return parsed.data.spaces.map((space) => ({
    spaceKey: space.key,
    selectedPageIds: space.pages === "all" ? null : space.pages,
  }))
}

/** The source scope of a tree selection, or null when it is not complete. */
export function confluenceSpaceItemsToScope(
  items: readonly SpaceScopeItem[],
): ConfluenceSourceScope | null {
  const parsed = confluenceSourceScopeSchema.safeParse(spaceItemsScope(items))
  return parsed.success ? parsed.data : null
}

/** The scope of a tree selection, before the schema checks it. */
function spaceItemsScope(items: readonly SpaceScopeItem[]) {
  return {
    spaces: items.map((item) => ({
      key: item.spaceKey,
      pages: item.selectedPageIds === null ? "all" : item.selectedPageIds,
    })),
  }
}

/** Select spaces, and all pages or some pages of each, with the page tree. */
export function ConfluenceScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [items, setItems] = useState(() =>
    confluenceScopeToSpaceItems(initialScope),
  )
  const heading = label ? `Spaces and pages for ${label}` : "Spaces and pages"
  const complete = confluenceSpaceItemsToScope(items) !== null
  const limitMessage = scopeLimitMessage(
    confluenceSourceScopeSchema,
    spaceItemsScope(items),
  )
  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <div className="flex h-[min(360px,calc(var(--visual-viewport-height)*0.5))] min-h-0 flex-col">
        <SpacePageTree
          orgSlug={orgSlug}
          atlassianConnectionId={connectionId}
          value={items}
          onChange={(next) => {
            setItems(next)
            onChange(confluenceSpaceItemsToScope(next))
          }}
        />
      </div>
      {limitMessage ? (
        <InlineAlert variant="error">{limitMessage}.</InlineAlert>
      ) : complete ? null : (
        <p className="text-sm text-muted-foreground">
          Select at least one space, or one page in each selected space.
        </p>
      )}
    </section>
  )
}

/** Confluence source UI: the space and page tree of the connection. */
export const confluenceSourceUi: SourceProviderUi = {
  Icon: ({ className }) => (
    <ConfluenceMark className={className} variant="outline" />
  ),
  ScopeEditor: ConfluenceScopeEditor,
  memberCanPick: true,
}
