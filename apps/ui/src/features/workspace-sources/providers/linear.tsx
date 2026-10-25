import { useQuery } from "@tanstack/react-query"
import { linearScopeSchema } from "backend/domain/workspace-sources/providers/linear"
import { useState } from "react"

import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { LinearScopeChecklist } from "@/features/connectors/components/linear-setup/LinearScopeChecklist"
import { LinearMark } from "@/features/connectors/components/LinearMark"
import {
  fetchLinearAvailableScopes,
  linearConnectorKeys,
} from "@/features/connectors/queries/linear-connector"

import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import {
  linearChecklistItems,
  linearScopeFromSelection,
  linearSelection,
  linearSelectionScope,
  matchLinearSelection,
} from "./linear-scope"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

/** Pick the Linear teams and projects that one Workspace syncs. */
export function LinearScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [selection, setSelection] = useState(() =>
    linearSelection(initialScope),
  )
  const [includeCustomerRequests, setIncludeCustomerRequests] = useState(
    initialScope.customerRequests !== "exclude",
  )
  const scopesQuery = useQuery({
    queryKey: linearConnectorKeys.availableScopes(orgSlug, connectionId),
    queryFn: () => fetchLinearAvailableScopes(orgSlug, connectionId),
  })
  const update = (next: { selection?: string[]; customers?: boolean }) => {
    const nextSelection = next.selection ?? selection
    const nextCustomers = next.customers ?? includeCustomerRequests
    setSelection(nextSelection)
    setIncludeCustomerRequests(nextCustomers)
    onChange(
      linearScopeFromSelection({
        base: initialScope,
        selection: nextSelection,
        includeCustomerRequests: nextCustomers,
      }),
    )
  }
  const pickerLabel = label
    ? `Linear teams and projects for ${label}`
    : "Linear teams and projects"

  if (scopesQuery.isPending)
    return <InlineLoader label="Loading Linear teams and projects" />
  if (scopesQuery.isError)
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">
          Could not load the Linear teams and projects.
        </p>
        <Button
          variant="secondary"
          className="rounded-md"
          onPress={() => void scopesQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    )

  const items = linearChecklistItems(scopesQuery.data, selection)
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-foreground">{pickerLabel}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A team syncs its issues, projects, cycles, and labels. A project syncs
          its issues from all teams.
        </p>
      </div>
      <LinearScopeChecklist
        aria-label={pickerLabel}
        items={items}
        value={matchLinearSelection(items, selection)}
        onChange={(value) => update({ selection: value })}
      />
      {selection.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Select at least one team or project.
        </p>
      ) : null}
      <ScopeLimitAlert
        schema={linearScopeSchema}
        scope={linearSelectionScope({
          base: initialScope,
          selection,
          includeCustomerRequests,
        })}
      />
      <Checkbox
        isSelected={includeCustomerRequests}
        onChange={(customers) => update({ customers })}
      >
        Include customer requests
      </Checkbox>
      <p className="text-xs text-muted-foreground">
        Customer requests can contain external names, feedback, or support
        context. Everyone who can read the Workspace repository can read them.
      </p>
    </div>
  )
}

export const linearSourceUi: SourceProviderUi = {
  Icon: LinearMark,
  ScopeEditor: LinearScopeEditor,
}
