import { useQuery } from "@tanstack/react-query"
import type { SourceProvider } from "backend/domain/workspace-sources/sources-file"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Radio, RadioGroup } from "@/components/ui/RadioGroup"
import {
  Skeleton,
  SkeletonText,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import { workspaceListOptions } from "@/features/workspaces/queries"
import {
  type ChooseWorkspacesValue,
  selectWorkspaces,
} from "./choose-workspaces"
import { SOURCE_PROVIDER_UI } from "./source-provider-ui"

export const CHOOSE_WORKSPACES_HINT =
  "You can add or change what each Workspace syncs at any time in its settings."

/**
 * The wizard step "Choose Workspaces": select one or more Workspaces, and
 * give them one shared scope or a scope for each. A connector wizard
 * includes it as a step and sends the result of `chooseWorkspacesRequests`.
 */
export function ChooseWorkspacesStep(props: {
  orgSlug: string
  provider: SourceProvider
  connectionId: string
  value: ChooseWorkspacesValue
  onChange: (value: ChooseWorkspacesValue) => void
}) {
  const { orgSlug, provider, connectionId, value, onChange } = props
  const listQuery = useQuery(workspaceListOptions(orgSlug))
  const loading = useSkeletonHold(listQuery.isPending)
  const workspaces = listQuery.data?.items ?? []
  const { ScopeEditor } = SOURCE_PROVIDER_UI[provider]
  const selected = workspaces.filter((workspace) =>
    value.workspaceSlugs.includes(workspace.slug),
  )
  const perWorkspace =
    value.scopeMode === "per_workspace" && selected.length > 1

  return (
    <div className="flex flex-col gap-5">
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          <span className="sr-only">Loading Workspaces</span>
          <SkeletonText className="text-sm" boneClassName="h-3.5 w-24" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-5 items-center gap-2">
              <Skeleton className="size-4.5 shrink-0" />
              <SkeletonText
                className="min-w-0 flex-1 text-sm"
                boneClassName="h-3.5 w-40"
              />
            </div>
          ))}
        </div>
      ) : listQuery.isError ? (
        <InlineAlert variant="error">
          Could not load the Workspaces.
        </InlineAlert>
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no Workspaces yet. Create a Workspace first.
        </p>
      ) : (
        <CheckboxGroup
          label="Workspaces"
          value={value.workspaceSlugs}
          onChange={(workspaceSlugs) =>
            onChange(selectWorkspaces(value, workspaceSlugs))
          }
        >
          {workspaces.map((workspace) => (
            <Checkbox key={workspace.id} value={workspace.slug}>
              {workspace.displayName}
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}

      {selected.length > 1 ? (
        <RadioGroup
          label="Scope"
          value={value.scopeMode}
          onChange={(mode) =>
            onChange({
              ...value,
              scopeMode: mode === "per_workspace" ? "per_workspace" : "shared",
            })
          }
        >
          <Radio value="shared">Same scope for each Workspace</Radio>
          <Radio value="per_workspace">
            A different scope for each Workspace
          </Radio>
        </RadioGroup>
      ) : null}

      {selected.length === 0 ? null : perWorkspace ? (
        selected.map((workspace) => (
          <ScopeEditor
            key={workspace.slug}
            orgSlug={orgSlug}
            provider={provider}
            connectionId={connectionId}
            label={workspace.displayName}
            initialScope={value.scopes[workspace.slug] ?? {}}
            onChange={(scope) =>
              onChange({
                ...value,
                scopes: { ...value.scopes, [workspace.slug]: scope },
              })
            }
          />
        ))
      ) : (
        <ScopeEditor
          key="shared"
          orgSlug={orgSlug}
          provider={provider}
          connectionId={connectionId}
          initialScope={value.sharedScope ?? {}}
          onChange={(sharedScope) => onChange({ ...value, sharedScope })}
        />
      )}

      <p className="text-sm text-muted-foreground">{CHOOSE_WORKSPACES_HINT}</p>
    </div>
  )
}
