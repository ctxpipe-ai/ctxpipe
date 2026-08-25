import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { workspaceListOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { githubRepoFullNameFromGitUrl } from "@/features/repositories/github-web-url"

export type WorkspaceDestination = {
  workspace: Workspace
  gitUrl: string
  repositoryName: string
  githubConnectionId: string | null
  branch: string
}

export function normalizeWorkspaceGitUrl(gitUrl: string): string {
  return gitUrl.trim().replace(/\.git$/i, "").toLowerCase()
}

export function destinationFromWorkspace(
  workspace: Workspace,
): WorkspaceDestination {
  return {
    workspace,
    gitUrl: workspace.workspaceRepositoryUrl,
    repositoryName:
      githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
      workspace.displayName,
    githubConnectionId: workspace.githubConnectionId,
    branch: "main",
  }
}

export function workspaceMatchingGitUrl(
  workspaces: readonly Workspace[],
  gitUrl: string | null | undefined,
): Workspace | null {
  if (!gitUrl) return null
  const wanted = normalizeWorkspaceGitUrl(gitUrl)
  return (
    workspaces.find(
      (workspace) =>
        normalizeWorkspaceGitUrl(workspace.workspaceRepositoryUrl) === wanted,
    ) ?? null
  )
}

export function ConnectorWorkspaceDestinationPicker(props: {
  orgSlug: string
  selectedWorkspaceId: string | null
  onSelect: (workspace: Workspace | null) => void
}) {
  const { orgSlug, selectedWorkspaceId, onSelect } = props
  const listQuery = useQuery(workspaceListOptions(orgSlug))
  const workspaces = listQuery.data?.items ?? []
  const selected =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null

  if (listQuery.isPending) {
    return <InlineLoader label="Loading workspaces" />
  }
  if (listQuery.isError) {
    return (
      <InlineAlert variant="error" title="Couldn’t load workspaces">
        Refresh and try again.
      </InlineAlert>
    )
  }
  if (workspaces.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Create a workspace first. Connector files go into that workspace
          repository.
        </p>
        <Link
          to="/$orgSlug/workspaces/new"
          params={{ orgSlug }}
          search={{ after: "settings" }}
          className="text-sm text-teal-400 hover:text-teal-300"
        >
          Create a workspace
        </Link>
      </div>
    )
  }

  return (
    <ComboBox
      label="Workspace"
      placeholder="Select a workspace"
      selectedKey={selected?.id ?? null}
      inputValue={selected?.displayName ?? ""}
      items={workspaces}
      onSelectionChange={(key) => {
        const next =
          workspaces.find((workspace) => workspace.id === String(key)) ?? null
        onSelect(next)
      }}
    >
      {(workspace) => (
        <ComboBoxItem id={workspace.id} textValue={workspace.displayName}>
          {workspace.displayName}
        </ComboBoxItem>
      )}
    </ComboBox>
  )
}
